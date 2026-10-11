// Native asynchronous computation and at-most-once callable rendezvous.
// Configuration and UI realms deliberately use different global sets.
use super::{float_filter, json_value, private_error, round_filter, PrivateSecrets, TextOutput};
use minijinja::{
    syntax::SyntaxConfig,
    value::{Kwargs, Object, ObjectRepr, Rest},
    Environment, Error, ErrorKind, State, Value,
};
use napi::{
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Env, JsFunction, Status,
};
use napi_derive::napi;
use serde_json::{json, Value as Json};
use std::{
    collections::HashMap,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
fn error() -> Error {
    Error::new(
        ErrorKind::InvalidOperation,
        "Private asynchronous template operation failed",
    )
}
pub(super) struct Budget {
    pub(super) items: usize,
    pub(super) bytes: usize,
}
pub(super) fn wire(value: &Value, depth: usize, budget: &mut Budget) -> Result<Json, Error> {
    budget.items += 1;
    if depth > 64 || budget.items > 65536 {
        return Err(error());
    }
    if let Some(text) = value.as_str() {
        budget.bytes += text.len();
        if budget.bytes > 65536 {
            return Err(error());
        }
    }
    Ok(match value.kind() {
        minijinja::value::ValueKind::None => json!(["none"]),
        minijinja::value::ValueKind::Bool => json!(["boolean", value.is_true()]),
        minijinja::value::ValueKind::String => json!(["string", value.as_str().ok_or_else(error)?]),
        minijinja::value::ValueKind::Number => {
            if value.is_integer() {
                json!(["integer", value.to_string()])
            } else {
                let number = f64::try_from(value.clone())?;
                json!([
                    "float",
                    if number.is_nan() {
                        "nan".to_owned()
                    } else if number == f64::INFINITY {
                        "inf".to_owned()
                    } else if number == f64::NEG_INFINITY {
                        "-inf".to_owned()
                    } else {
                        number.to_string()
                    }
                ])
            }
        }
        minijinja::value::ValueKind::Seq => json!([
            "list",
            value
                .try_iter()?
                .map(|v| wire(&v, depth + 1, budget))
                .collect::<Result<Vec<_>, _>>()?
        ]),
        minijinja::value::ValueKind::Map => json!([
            "map",
            value
                .try_iter()?
                .map(|k| Ok(json!([
                    wire(&k, depth + 1, budget)?,
                    wire(&value.get_item(&k)?, depth + 1, budget)?
                ])))
                .collect::<Result<Vec<_>, Error>>()?
        ]),
        _ => return Err(error()),
    })
}
pub(super) fn unwire(value: &Json, depth: usize) -> Result<Value, Error> {
    if depth > 64 {
        return Err(error());
    }
    let row = value.as_array().ok_or_else(error)?;
    let kind = row.first().and_then(Json::as_str).ok_or_else(error)?;
    if kind == "none" && row.len() == 1 {
        return Ok(Value::from(()));
    }
    if row.len() != 2 {
        return Err(error());
    }
    Ok(match kind {
        "boolean" => Value::from(row[1].as_bool().ok_or_else(error)?),
        "string" => Value::from(row[1].as_str().ok_or_else(error)?.to_owned()),
        "integer" => {
            let text = row[1].as_str().ok_or_else(error)?;
            let digits = text.strip_prefix('-').unwrap_or(text);
            if digits.is_empty()
                || !digits.bytes().all(|b| b.is_ascii_digit())
                || (digits.len() > 1 && digits.starts_with('0'))
            {
                return Err(error());
            }
            Value::from(text.parse::<i128>().map_err(|_| error())?)
        }
        "float" => {
            let text = row[1].as_str().ok_or_else(error)?;
            let number = match text {
                "nan" => f64::NAN,
                "inf" => f64::INFINITY,
                "-inf" => f64::NEG_INFINITY,
                _ => {
                    let n = text.parse::<f64>().map_err(|_| error())?;
                    if !n.is_finite() {
                        return Err(error());
                    }
                    n
                }
            };
            Value::from(number)
        }
        "list" => Value::from(
            row[1]
                .as_array()
                .ok_or_else(error)?
                .iter()
                .map(|v| unwire(v, depth + 1))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        "map" => row[1]
            .as_array()
            .ok_or_else(error)?
            .iter()
            .map(|p| {
                let p = p.as_array().ok_or_else(error)?;
                if p.len() != 2 {
                    return Err(error());
                }
                Ok((unwire(&p[0], depth + 1)?, unwire(&p[1], depth + 1)?))
            })
            .collect::<Result<Value, Error>>()?,
        _ => return Err(error()),
    })
}
enum Reply {
    Wire(String),
    Float(f64),
}
type Waiters = HashMap<(u32, u32), SyncSender<Result<Reply, ()>>>;
struct Lane {
    sender: SyncSender<Job>,
    load: Arc<AtomicU32>,
}
struct Runtime {
    closed: Arc<AtomicBool>,
    sender: Mutex<Option<Vec<Lane>>>,
    callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    waiters: Mutex<Waiters>,
    frames: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}
struct Frame {
    runtime: Arc<Runtime>,
    id: u32,
    cancelled: Arc<AtomicBool>,
    sequence: AtomicU32,
    deadline: Instant,
}
impl Frame {
    fn check(&self) -> Result<(), Error> {
        if self.cancelled.load(Ordering::Acquire)
            || self.runtime.closed.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
        {
            Err(error())
        } else {
            Ok(())
        }
    }
    fn invoke(&self, name: &str, args: &[Value]) -> Result<Value, Error> {
        self.check()?;
        let seq = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        if seq > 64 {
            return Err(error());
        }
        let (args, kwargs): (Rest<Value>, Kwargs) = minijinja::value::from_args(args)?;
        let mut budget = Budget { items: 0, bytes: 0 };
        let positional = args
            .0
            .iter()
            .map(|v| wire(v, 0, &mut budget))
            .collect::<Result<Vec<_>, _>>()?;
        let named = kwargs
            .args()
            .map(|name| {
                Ok(json!([
                    name,
                    wire(&kwargs.get::<Value>(name)?, 0, &mut budget)?
                ]))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        kwargs.assert_all_used()?;
        let message =
            json!({"render":self.id,"call":seq,"name":name,"args":positional,"kwargs":named})
                .to_string();
        if message.len() > 65536 {
            return Err(error());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.runtime
            .waiters
            .lock()
            .map_err(|_| error())?
            .insert((self.id, seq), tx);
        let result = (|| {
            if self
                .runtime
                .callback
                .call(message, ThreadsafeFunctionCallMode::NonBlocking)
                != Status::Ok
            {
                return Err(error());
            }
            loop {
                self.check()?;
                match rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(Ok(Reply::Float(value))) => {
                        self.check()?;
                        return Ok(Value::from(value));
                    }
                    Ok(Ok(Reply::Wire(text))) => {
                        if text.len() > 65536 {
                            return Err(error());
                        }
                        self.check()?;
                        return unwire(&serde_json::from_str(&text).map_err(|_| error())?, 0);
                    }
                    Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => return Err(error()),
                    Err(RecvTimeoutError::Timeout) => continue,
                }
            }
        })();
        self.runtime
            .waiters
            .lock()
            .map_err(|_| error())?
            .remove(&(self.id, seq));
        result
    }
}
#[derive(Debug)]
struct Callable {
    frame: Arc<Frame>,
    name: String,
}
impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Private template frame")
    }
}
impl Object for Callable {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Plain
    }
    fn call(self: &Arc<Self>, _state: &State<'_, '_>, args: &[Value]) -> Result<Value, Error> {
        self.frame.invoke(&self.name, args)
    }
}
struct Job {
    environment: Environment<'static>,
    context: Value,
    frame: Arc<Frame>,
    lane_load: Arc<AtomicU32>,
}
impl Job {
    fn run(self) {
        let result = catch_unwind(AssertUnwindSafe(|| {
            self.frame.check()?;
            let mut out = TextOutput(Vec::new());
            self.environment
                .get_template("text")?
                .render_captured_to(self.context, &mut out)?;
            self.frame.check()?;
            String::from_utf8(out.0).map_err(|_| error())
        }));
        self.frame
            .runtime
            .frames
            .lock()
            .ok()
            .map(|mut m| m.remove(&self.frame.id));
        self.frame
            .runtime
            .waiters
            .lock()
            .ok()
            .map(|mut m| m.retain(|(id, _), _| *id != self.frame.id));
        self.lane_load.fetch_sub(1, Ordering::AcqRel);
        let message = match result {
            Ok(Ok(text)) => json!({"render":self.frame.id,"done":true,"text":text}),
            _ => json!({"render":self.frame.id,"done":true,"error":true}),
        }
        .to_string();
        // A single executor-owned channel reports completions as well as
        // calls. Never allocate a new Node TSFN for every render.
        self.frame
            .runtime
            .callback
            .call(message, ThreadsafeFunctionCallMode::Blocking);
    }
}
#[napi]
pub struct NativeTemplateExecutor {
    runtime: Arc<Runtime>,
}
#[napi]
impl NativeTemplateExecutor {
    #[napi(constructor)]
    pub fn new(env: Env, callback: JsFunction) -> napi::Result<Self> {
        let mut callback: ThreadsafeFunction<String, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(
                32,
                |ctx: napi::threadsafe_function::ThreadSafeCallContext<String>| {
                    Ok(vec![ctx.env.create_string(&ctx.value)?])
                },
            )?;
        callback.unref(&env)?;
        let mut lanes = Vec::new();
        let closed = Arc::new(AtomicBool::new(false));
        for _ in 0..2 {
            let (tx, rx) = mpsc::sync_channel::<Job>(32);
            thread::Builder::new()
                .name("anyraid-template".into())
                .spawn(move || loop {
                    match rx.recv() {
                        Ok(job) => job.run(),
                        Err(_) => return,
                    }
                })
                .map_err(|_| private_error())?;
            lanes.push(Lane {
                sender: tx,
                load: Arc::new(AtomicU32::new(0)),
            });
        }
        Ok(Self {
            runtime: Arc::new(Runtime {
                closed,
                sender: Mutex::new(Some(lanes)),
                callback,
                waiters: Mutex::new(HashMap::new()),
                frames: Mutex::new(HashMap::new()),
            }),
        })
    }
    #[napi]
    pub fn create_template(
        &self,
        source: String,
        secrets: String,
        file: String,
        format: String,
        ui: bool,
    ) -> napi::Result<NativeAsyncTextTemplate> {
        if self.runtime.closed.load(Ordering::Acquire)
            || source.len() > 65536
            || secrets.len() > 1048576
            || file.len() > 4096
        {
            return Err(private_error());
        }
        let mut env = Environment::new();
        env.set_formatter(|out, state, value| {
            if value.kind() == minijinja::value::ValueKind::Number
                && !value.is_integer()
                && f64::try_from(value.clone())?.is_nan()
            {
                minijinja::escape_formatter(out, state, &Value::from("nan"))
            } else {
                minijinja::escape_formatter(out, state, value)
            }
        });
        if !ui {
            env.set_syntax(
                SyntaxConfig::builder()
                    .variable_delimiters("{", "}")
                    .build()
                    .map_err(|_| private_error())?,
            );
        }
        env.set_fuel(Some(100000));
        env.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
        env.add_filter("fromjson", |text: String| -> Result<Value, Error> {
            if text.len() > 65536 {
                return Err(error());
            }
            json_value(serde_json::from_str(&text).map_err(|_| error())?, 0)
        });
        env.add_filter("float", float_filter);
        env.add_filter("round", round_filter);
        if !ui {
            if !matches!(format.as_str(), "json" | "ini" | "invalid") {
                return Err(private_error());
            }
            let values = json_value(
                serde_json::from_str(&secrets).map_err(|_| private_error())?,
                0,
            )
            .map_err(|_| private_error())?;
            if values.kind() != minijinja::value::ValueKind::Map {
                return Err(private_error());
            }
            env.add_global(
                "secrets",
                Value::from_object(PrivateSecrets {
                    values,
                    file,
                    format,
                }),
            );
            env.add_function(
                "raise_error",
                |_message: String, _code: Option<i64>| -> Result<Value, Error> { Err(error()) },
            );
            env.add_function("log_debug", |_message: String| Value::from(()));
        }
        env.add_template_owned("text", source)
            .map_err(|_| private_error())?;
        Ok(NativeAsyncTextTemplate {
            runtime: self.runtime.clone(),
            environment: Some(env),
            globals: Vec::new(),
            ui,
        })
    }
    #[napi]
    pub fn respond(&self, render: u32, call: u32, value: Option<String>) -> bool {
        let tx = self
            .runtime
            .waiters
            .lock()
            .ok()
            .and_then(|mut w| w.remove(&(render, call)));
        if let Some(tx) = tx {
            let result = value
                .filter(|v| v.len() <= 65536)
                .map(Reply::Wire)
                .ok_or(());
            tx.try_send(result).is_ok()
        } else {
            false
        }
    }
    #[napi]
    pub fn respond_float(&self, render: u32, call: u32, value: f64) -> bool {
        self.runtime
            .waiters
            .lock()
            .ok()
            .and_then(|mut w| w.remove(&(render, call)))
            .map(|tx| tx.try_send(Ok(Reply::Float(value))).is_ok())
            .unwrap_or(false)
    }
    #[napi]
    pub fn cancel(&self, id: u32) {
        if let Ok(frames) = self.runtime.frames.lock() {
            if let Some(frame) = frames.get(&id) {
                frame.store(true, Ordering::Release);
            }
        }
    }
    #[napi]
    pub fn close(&self) {
        self.runtime.closed.store(true, Ordering::Release);
        if let Ok(mut sender) = self.runtime.sender.lock() {
            sender.take();
        }
        if let Ok(mut w) = self.runtime.waiters.lock() {
            w.clear();
        }
    }
}
impl Drop for NativeTemplateExecutor {
    fn drop(&mut self) {
        self.close();
    }
}
struct Global {
    name: String,
    value: Option<Value>,
}
#[napi]
pub struct NativeAsyncTextTemplate {
    runtime: Arc<Runtime>,
    environment: Option<Environment<'static>>,
    globals: Vec<Global>,
    ui: bool,
}
#[napi]
impl NativeAsyncTextTemplate {
    #[napi]
    pub fn add_global(&mut self, name: String, value: Option<String>) -> napi::Result<()> {
        if self.ui || name.is_empty() || name.len() > 128 || self.globals.len() >= 64 {
            return Err(private_error());
        }
        let env = self.environment.as_mut().ok_or_else(private_error)?;
        if env.globals().any(|(key, _)| key == name) || self.globals.iter().any(|g| g.name == name)
        {
            return Err(private_error());
        }
        let value = match value {
            Some(v) => {
                if v.len() > 65536 {
                    return Err(private_error());
                }
                Some(
                    unwire(&serde_json::from_str(&v).map_err(|_| private_error())?, 0)
                        .map_err(|_| private_error())?,
                )
            }
            None => None,
        };
        self.globals.push(Global { name, value });
        Ok(())
    }
    #[napi]
    pub fn render(
        &self,
        context: String,
        callables: Vec<String>,
        id: u32,
        timeout_ms: u32,
    ) -> napi::Result<()> {
        if context.len() > 65536
            || callables.len() > 64
            || !(1..=10000).contains(&timeout_ms)
            || self.runtime.closed.load(Ordering::Acquire)
        {
            return Err(private_error());
        }
        let mut environment = self.environment.as_ref().ok_or_else(private_error)?.clone();
        let mut context = json_value(
            serde_json::from_str(&context).map_err(|_| private_error())?,
            0,
        )
        .map_err(|_| private_error())?;
        if context.kind() != minijinja::value::ValueKind::Map {
            return Err(private_error());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut frames = self.runtime.frames.lock().map_err(|_| private_error())?;
            if frames.len() >= 32 || frames.contains_key(&id) {
                return Err(private_error());
            }
            frames.insert(id, cancelled.clone());
        }
        let frame = Arc::new(Frame {
            runtime: self.runtime.clone(),
            id,
            cancelled,
            sequence: AtomicU32::new(0),
            deadline: Instant::now() + Duration::from_millis(timeout_ms.into()),
        });
        for global in &self.globals {
            let value = global.value.clone().unwrap_or_else(|| {
                Value::from_object(Callable {
                    frame: frame.clone(),
                    name: global.name.clone(),
                })
            });
            environment.add_global(global.name.clone(), value);
        }
        let mut values = context
            .try_iter()
            .map_err(|_| private_error())?
            .map(|k| Ok((k.clone(), context.get_item(&k)?)))
            .collect::<Result<Vec<_>, Error>>()
            .map_err(|_| private_error())?;
        for name in callables {
            if name.is_empty() || name.len() > 128 {
                self.runtime.frames.lock().ok().map(|mut m| m.remove(&id));
                return Err(private_error());
            }
            values.retain(|(k, _)| k.as_str() != Some(&name));
            values.push((
                Value::from(name.clone()),
                Value::from_object(Callable {
                    frame: frame.clone(),
                    name,
                }),
            ));
        }
        context = values.into_iter().collect();
        let sender = self.runtime.sender.lock().map_err(|_| private_error())?;
        if let Some(lanes) = sender.as_ref() {
            // The lowest load wins; equal empty lanes always choose the first.
            // Sequential calls reuse its thread instead of bouncing between
            // workers waiting on a shared receiver mutex.
            let lane = lanes
                .iter()
                .min_by_key(|lane| lane.load.load(Ordering::Acquire))
                .ok_or_else(private_error)?;
            lane.load.fetch_add(1, Ordering::AcqRel);
            let job = Job {
                environment,
                context,
                frame,
                lane_load: lane.load.clone(),
            };
            if let Err(e) = lane.sender.try_send(job) {
                lane.load.fetch_sub(1, Ordering::AcqRel);
                self.runtime.frames.lock().ok().map(|mut m| m.remove(&id));
                let _job = match e {
                    TrySendError::Full(job) | TrySendError::Disconnected(job) => job,
                };
                return Err(private_error());
            }
        } else {
            self.runtime.frames.lock().ok().map(|mut m| m.remove(&id));
            return Err(private_error());
        }
        Ok(())
    }
    #[napi]
    pub fn close(&mut self) {
        self.environment = None;
        self.globals.clear();
    }
}
