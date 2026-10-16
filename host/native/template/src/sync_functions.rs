// Synchronous callbacks stay on the current Node thread and native call scope.
// No napi Env or JsFunction is sent to background threads or retained in a template.
use super::{
    async_text::{unwire, wire, Budget},
    private_error, TextOutput,
};
use minijinja::{
    value::{Kwargs, Object, ObjectRepr, Rest},
    Environment, Error, ErrorKind, State, Value,
};
use napi::{Env, JsFunction, ValueType};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::Arc,
    thread::{self, ThreadId},
    time::{Duration, Instant},
};

fn error() -> Error {
    Error::new(
        ErrorKind::InvalidOperation,
        "Private synchronous callable failed",
    )
}
struct Frame {
    env: Env,
    callback: JsFunction,
    sequence: Cell<u32>,
    deadline: Instant,
}
struct Frames {
    next: u64,
    active: HashMap<u64, Rc<Frame>>,
}
thread_local! { static FRAMES:RefCell<Frames> = RefCell::new(Frames { next:0, active:HashMap::new() }); }
struct Scope(u64);
impl Drop for Scope {
    fn drop(&mut self) {
        FRAMES.with(|frames| {
            frames.borrow_mut().active.remove(&self.0);
        });
    }
}
#[derive(Debug)]
struct Callable {
    frame: u64,
    thread: ThreadId,
    name: String,
}
impl Object for Callable {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Plain
    }
    fn call(self: &Arc<Self>, _state: &State<'_, '_>, args: &[Value]) -> Result<Value, Error> {
        if thread::current().id() != self.thread {
            return Err(error());
        }
        // Release the RefCell borrow before calling JS so nested renders get
        // independent frames, and the outer frame remains alive until return.
        let frame = FRAMES
            .with(|frames| frames.borrow().active.get(&self.frame).cloned())
            .ok_or_else(error)?;
        let sequence = frame.sequence.get() + 1;
        frame.sequence.set(sequence);
        if sequence > 64 || Instant::now() >= frame.deadline {
            return Err(error());
        }
        let (args, kwargs): (Rest<Value>, Kwargs) = minijinja::value::from_args(args)?;
        let mut budget = Budget { items: 0, bytes: 0 };
        let positional = args
            .0
            .iter()
            .map(|value| wire(value, 0, &mut budget))
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
            json!({"call":sequence,"name":self.name,"args":positional,"kwargs":named}).to_string();
        if message.len() > 65536 {
            return Err(error());
        }
        let arg = frame.env.create_string(&message).map_err(|_| error())?;
        let result = frame.callback.call(None, &[arg]).map_err(|_| error())?;
        if result.get_type().map_err(|_| error())? != ValueType::String
            || Instant::now() >= frame.deadline
        {
            return Err(error());
        }
        let result = result
            .coerce_to_string()
            .map_err(|_| error())?
            .into_utf8()
            .map_err(|_| error())?;
        let text = result.as_str().map_err(|_| error())?;
        if text.len() > 65536 {
            return Err(error());
        }
        unwire(&serde_json::from_str(text).map_err(|_| error())?, 0)
    }
}
pub(super) fn render(
    env: Env,
    mut environment: Environment<'static>,
    context: Value,
    globals: Vec<String>,
    names: Vec<String>,
    callback: JsFunction,
) -> napi::Result<String> {
    if names.len() > 64 || names.iter().any(|name| name.is_empty() || name.len() > 128) {
        return Err(private_error());
    }
    let scope = FRAMES.with(|frames| {
        let mut frames = frames.borrow_mut();
        if frames.active.len() >= 16 {
            return Err(private_error());
        }
        frames.next = frames.next.checked_add(1).ok_or_else(private_error)?;
        let id = frames.next;
        frames.active.insert(
            id,
            Rc::new(Frame {
                env,
                callback,
                sequence: Cell::new(0),
                deadline: Instant::now() + Duration::from_secs(10),
            }),
        );
        Ok(Scope(id))
    })?;
    let callable = |name: String| {
        Value::from_object(Callable {
            frame: scope.0,
            thread: thread::current().id(),
            name,
        })
    };
    for name in globals {
        environment.add_global(name.clone(), callable(name));
    }
    let mut values = context
        .try_iter()
        .map_err(|_| private_error())?
        .map(|key| Ok((key.clone(), context.get_item(&key)?)))
        .collect::<Result<Vec<_>, Error>>()
        .map_err(|_| private_error())?;
    for name in names {
        values.retain(|(key, _)| key.as_str() != Some(&name));
        values.push((Value::from(name.clone()), callable(name)));
    }
    let context: Value = values.into_iter().collect();
    let mut output = TextOutput(Vec::new());
    environment
        .get_template("text")
        .map_err(|_| private_error())?
        .render_captured_to(context, &mut output)
        .map_err(|_| private_error())?;
    String::from_utf8(output.0).map_err(|_| private_error())
}
