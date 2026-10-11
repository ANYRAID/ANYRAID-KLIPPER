// Sensor side effects are frame-local in the shared private text environment.
// Collect typed readings in Rust instead of invoking JS once per parameter.
use super::{err, numeric, private_error, python_float, TypedReading};
use minijinja::{
    value::{Kwargs, Object, ObjectRepr, Rest, ValueKind},
    Error, State, Value,
};
use std::sync::{Arc, Mutex};

pub(super) struct SensorFrame(Arc<SensorResult>);
struct SensorResult(Mutex<Vec<TypedReading>>);
impl std::fmt::Debug for SensorResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SensorResult <private>")
    }
}
impl Object for SensorResult {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Plain
    }
    fn call(self: &Arc<Self>, _state: &State<'_, '_>, args: &[Value]) -> Result<Value, Error> {
        let (positional, kwargs): (Rest<Value>, Kwargs) = minijinja::value::from_args(args)?;
        if positional.0.len() > 2 {
            return Err(err("Invalid sensor binding"));
        }
        let bind = |index: usize, key: &str| -> Result<Value, Error> {
            let named: Option<Value> = kwargs.get(key)?;
            match (positional.0.get(index), named) {
                (Some(value), None) => Ok(value.clone()),
                (None, Some(value)) => Ok(value),
                _ => Err(err("Invalid sensor binding")),
            }
        };
        let name = bind(0, "name")?;
        let value = bind(1, "value")?;
        kwargs.assert_all_used()?;
        let name = name.as_str().ok_or_else(|| err("Invalid parameter name"))?;
        if name.is_empty() || name.len() > 256 {
            return Err(err("Invalid parameter name"));
        }
        let boolean = value.kind() == ValueKind::Bool;
        let integer = value.is_integer();
        let number = if boolean {
            None
        } else {
            Some(if let Some(text) = value.as_str() {
                python_float(text).ok_or_else(|| err("Invalid sensor number"))?
            } else {
                numeric(value.clone())?
            })
        };
        if number
            .is_some_and(|value| !value.is_finite() || integer && value.abs() > 9007199254740991.0)
        {
            return Err(err("Unsafe sensor number"));
        }
        let reading = TypedReading {
            name: name.into(),
            number_type: if boolean {
                "boolean"
            } else if integer {
                "integer"
            } else {
                "float"
            }
            .into(),
            number_value: number,
            boolean_value: boolean.then(|| value.is_true()),
        };
        let mut items = self.0.lock().map_err(|_| err("Invalid sensor frame"))?;
        if let Some(index) = items.iter().position(|item| item.name == name) {
            items[index] = reading;
        } else {
            if items.len() >= 16 {
                return Err(err("Parameter limit"));
            }
            items.push(reading);
        }
        Ok(Value::from(()))
    }
}
impl SensorFrame {
    pub(super) fn new() -> Self {
        Self(Arc::new(SensorResult(Mutex::new(Vec::new()))))
    }
    pub(super) fn context(&self, payload: String) -> Value {
        minijinja::context! {payload => payload, set_result => Value::from_dyn_object(self.0.clone())}
    }
    pub(super) fn finish(self) -> napi::Result<Vec<TypedReading>> {
        Ok(std::mem::take(
            &mut *self.0 .0.lock().map_err(|_| private_error())?,
        ))
    }
}
