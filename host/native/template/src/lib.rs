use minijinja::{syntax::SyntaxConfig, value::ValueKind, Environment, Error, ErrorKind, Value};
use napi_derive::napi;
use num_bigint::{BigInt, BigUint};
use num_traits::{FromPrimitive, One};
use std::{
    io,
    sync::{Arc, Mutex},
};
fn err(message: &str) -> Error {
    Error::new(ErrorKind::InvalidOperation, message.to_owned())
}
fn js_err(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
fn numeric(value: Value) -> Result<f64, Error> {
    f64::try_from(value)
}
fn json_value(value: serde_json::Value, depth: usize) -> Result<Value, Error> {
    if depth > 64 {
        return Err(err("JSON nesting exceeds limit"));
    }
    Ok(match value {
        serde_json::Value::Null => Value::from(()),
        serde_json::Value::Bool(v) => Value::from(v),
        serde_json::Value::String(v) => Value::from(v),
        serde_json::Value::Number(v) => {
            let text = v.as_str();
            if text.contains(['.', 'e', 'E']) {
                let value = text.parse::<f64>().map_err(|_| err("Invalid JSON float"))?;
                if !value.is_finite() {
                    return Err(err("Nonfinite JSON number"));
                }
                Value::from(value)
            } else {
                Value::from(
                    text.parse::<i128>()
                        .map_err(|_| err("JSON integer exceeds i128 range"))?,
                )
            }
        }
        serde_json::Value::Array(values) => Value::from(
            values
                .into_iter()
                .map(|v| json_value(v, depth + 1))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        serde_json::Value::Object(values) => values
            .into_iter()
            .map(|(k, v)| Ok((Value::from(k), json_value(v, depth + 1)?)))
            .collect::<Result<Value, Error>>()?,
    })
}
const ZEROS: &[u32] = &[
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66,
    0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90,
    0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10,
    0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
    0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0,
    0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950,
    0x1fbf0,
];
fn python_float(text: &str) -> Option<f64> {
    let normalized: String = text
        .trim_matches(char::is_whitespace)
        .chars()
        .map(|c| {
            let code = c as u32;
            ZEROS
                .iter()
                .find(|&&zero| code >= zero && code < zero + 10)
                .map(|zero| char::from_u32(48 + code - zero).unwrap())
                .unwrap_or(c)
        })
        .collect();
    let bytes = normalized.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'_'
            && (i == 0
                || i + 1 == bytes.len()
                || !bytes[i - 1].is_ascii_digit()
                || !bytes[i + 1].is_ascii_digit())
        {
            return None;
        }
    }
    normalized.replace('_', "").parse().ok()
}
fn float_filter(value: Value, default: Option<Value>) -> Result<Value, Error> {
    if value.kind() == ValueKind::Bool {
        return Ok(Value::from(if value.is_true() { 1.0 } else { 0.0 }));
    }
    if value.is_number() {
        return Ok(Value::from(numeric(value)?));
    }
    if let Some(text) = value.as_str() {
        if let Some(number) = python_float(text) {
            return Ok(Value::from(number));
        }
    }
    Ok(default.unwrap_or_else(|| Value::from(0.0)))
}
fn rounded_quotient(numerator: BigUint, denominator: BigUint) -> BigUint {
    let mut quotient = &numerator / &denominator;
    let twice = (&numerator % &denominator) << 1usize;
    if twice > denominator
        || (twice == denominator && (&quotient & BigUint::one()) == BigUint::one())
    {
        quotient += 1u32;
    }
    quotient
}
fn round_filter(
    value: Value,
    precision: Option<i64>,
    method: Option<String>,
) -> Result<Value, Error> {
    let p = precision.unwrap_or(0);
    let method = method.as_deref().unwrap_or("common");
    if !["common", "ceil", "floor"].contains(&method) {
        return Err(err("Invalid rounding method"));
    }
    // Python bool implements integer rounding, with an int result for common.
    let value = if value.kind() == ValueKind::Bool {
        Value::from(if value.is_true() { 1i128 } else { 0i128 })
    } else {
        value
    };
    // For nonnegative integral precision, Python computes the integer product
    // and ceil/floor exactly before dividing. Converting before multiplication
    // introduces a rounding error near 2^53 and overflows at large precision.
    if method != "common" && value.is_integer() && p >= 0 {
        return Ok(Value::from(numeric(value)?));
    }
    if method == "common" && value.is_integer() {
        if p >= 0 {
            return Ok(value);
        }
        if p < -39 {
            return Ok(Value::from(0));
        }
        let integer = i128::try_from(value)?;
        let quotient = rounded_quotient(
            BigUint::from(integer.unsigned_abs()),
            BigUint::from(10u32).pow((-p) as u32),
        ) * BigUint::from(10u32).pow((-p) as u32);
        return Ok(Value::from(
            format!("{}{}", if integer < 0 { "-" } else { "" }, quotient)
                .parse::<i128>()
                .map_err(|_| err("Integer round overflow"))?,
        ));
    }
    let number = numeric(value)?;
    if method == "common" {
        if !number.is_finite() || number == 0.0 || p > 323 {
            return Ok(Value::from(number));
        }
        if p < -308 {
            return Ok(Value::from(0.0f64.copysign(number)));
        }
        let bits = number.to_bits();
        let exponent = ((bits >> 52) & 2047) as i32;
        let mut n =
            BigUint::from((bits & ((1u64 << 52) - 1)) + if exponent != 0 { 1u64 << 52 } else { 0 });
        let mut d = BigUint::one();
        let power = if exponent != 0 {
            exponent - 1075
        } else {
            -1074
        };
        if power >= 0 {
            n <<= power as usize;
        } else {
            d <<= (-power) as usize;
        }
        if p >= 0 {
            n *= BigUint::from(10u32).pow(p as u32);
        } else {
            d *= BigUint::from(10u32).pow((-p) as u32);
        }
        let quotient = rounded_quotient(n, d);
        let result = format!(
            "{}{}e{}",
            if number.is_sign_negative() { "-" } else { "" },
            quotient,
            -p
        )
        .parse::<f64>()
        .map_err(|_| err("Float round error"))?;
        if !result.is_finite() {
            return Err(err("Float round overflow"));
        }
        return Ok(Value::from(result));
    }
    if !number.is_finite() || p > 308 {
        return Err(err("Rounding overflow"));
    }
    let factor = if p >= 0 {
        format!("1e{}", p).parse::<f64>().unwrap()
    } else {
        10f64.powf(p as f64)
    };
    if factor == 0.0 {
        return Err(err("Rounding division by zero"));
    }
    let scaled = number * factor;
    if !scaled.is_finite() {
        return Err(err("Rounding overflow"));
    }
    let rounded = if method == "ceil" {
        scaled.ceil()
    } else {
        scaled.floor()
    };
    let result = if p >= 0 {
        format!(
            "{}e-{}",
            BigInt::from_f64(rounded).ok_or_else(|| err("Rounding overflow"))?,
            p
        )
        .parse::<f64>()
        .map_err(|_| err("Rounding error"))?
    } else {
        (if rounded == 0.0 { 0.0 } else { rounded }) / factor
    };
    Ok(Value::from(result))
}
#[napi(object)]
#[derive(Clone)]
pub struct TypedReading {
    pub name: String,
    pub number_type: String,
    pub number_value: Option<f64>,
    pub boolean_value: Option<bool>,
}
struct BoundedOutput(usize);
impl io::Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0 + bytes.len() > 65536 {
            return Err(io::Error::other("Template output limit"));
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[napi]
pub struct NativeSensorTemplate {
    environment: Option<Environment<'static>>,
    readings: Arc<Mutex<Vec<TypedReading>>>,
}
#[napi]
impl NativeSensorTemplate {
    #[napi(constructor)]
    pub fn new(source: String) -> napi::Result<Self> {
        if source.len() > 65536 {
            return Err(js_err("Template source limit"));
        }
        let mut env = Environment::new();
        env.set_syntax(
            SyntaxConfig::builder()
                .variable_delimiters("{", "}")
                .build()
                .map_err(js_err)?,
        );
        env.set_fuel(Some(100000));
        env.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
        env.add_filter("fromjson", |text: String| -> Result<Value, Error> {
            if text.len() > 65536 {
                return Err(err("JSON payload limit"));
            }
            json_value(
                serde_json::from_str(&text).map_err(|_| err("Invalid JSON"))?,
                0,
            )
        });
        env.add_filter("float", float_filter);
        env.add_filter("round", round_filter);
        let readings = Arc::new(Mutex::new(Vec::<TypedReading>::new()));
        let captured = readings.clone();
        env.add_function(
            "set_result",
            move |name: String, value: Value| -> Result<Value, Error> {
                if name.is_empty() || name.len() > 256 {
                    return Err(err("Invalid parameter name"));
                }
                let boolean = value.kind() == ValueKind::Bool;
                let boolean_value = if boolean { Some(value.is_true()) } else { None };
                let integer = value.is_integer();
                let value = if boolean {
                    None
                } else {
                    Some(if let Some(text) = value.as_str() {
                        python_float(text).ok_or_else(|| err("Invalid sensor number"))?
                    } else {
                        numeric(value.clone())?
                    })
                };
                if value
                    .is_some_and(|v| !v.is_finite() || (integer && v.abs() > 9007199254740991.0))
                {
                    return Err(err("Unsafe sensor number"));
                }
                let reading = TypedReading {
                    name,
                    number_type: if boolean {
                        "boolean"
                    } else if integer {
                        "integer"
                    } else {
                        "float"
                    }
                    .into(),
                    number_value: value,
                    boolean_value,
                };
                let mut items = captured
                    .lock()
                    .map_err(|_| err("Poisoned template frame"))?;
                if let Some(index) = items.iter().position(|item| item.name == reading.name) {
                    items[index] = reading;
                } else {
                    if items.len() >= 16 {
                        return Err(err("Parameter limit"));
                    }
                    items.push(reading);
                }
                Ok(Value::from(()))
            },
        );
        env.add_template_owned("sensor".to_owned(), source)
            .map_err(js_err)?;
        Ok(Self {
            environment: Some(env),
            readings,
        })
    }
    #[napi]
    pub fn render(&mut self, payload: String) -> napi::Result<Vec<TypedReading>> {
        if payload.len() > 65536 {
            return Err(js_err("Payload limit"));
        }
        let env = self
            .environment
            .as_ref()
            .ok_or_else(|| js_err("Template closed"))?;
        self.readings.lock().map_err(js_err)?.clear();
        let result = env
            .get_template("sensor")
            .map_err(js_err)?
            .render_captured_to(
                minijinja::context! {payload=>payload},
                &mut BoundedOutput(0),
            )
            .map(|_| ());
        let mut readings = self.readings.lock().map_err(js_err)?;
        match result {
            Ok(_) => {
                let result = readings.clone();
                readings.clear();
                Ok(result)
            }
            Err(error) => {
                readings.clear();
                Err(js_err(error))
            }
        }
    }
    #[napi]
    pub fn close(&mut self) {
        self.environment = None;
        if let Ok(mut readings) = self.readings.lock() {
            readings.clear();
        }
    }
}
