"""Tiny JSON Schema subset validator (stdlib only): type, properties, required,
additionalProperties, items, enum. Enough for the fixed schemas used by the kits.

STATUS: written only; never exercised against a real CLI/engine.
"""

_TYPES = {
    "object": dict, "array": list, "string": str, "boolean": bool, "null": type(None),
}


def _type_ok(value, name):
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, _TYPES[name])


def validate(value, schema, path="$"):
    """Return a list of error strings (empty list means valid)."""
    errors = []
    if "enum" in schema and value not in schema["enum"]:
        errors.append("{}: {!r} not in enum".format(path, value))
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        if not any(_type_ok(value, n) for n in names):
            errors.append("{}: expected {}, got {}".format(path, "/".join(names), type(value).__name__))
            return errors
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                errors.append("{}: missing required '{}'".format(path, name))
        for key, sub in value.items():
            if key in props:
                errors.extend(validate(sub, props[key], "{}.{}".format(path, key)))
            elif schema.get("additionalProperties") is False:
                errors.append("{}: additional property '{}' not allowed".format(path, key))
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            errors.extend(validate(item, schema["items"], "{}[{}]".format(path, i)))
    return errors
