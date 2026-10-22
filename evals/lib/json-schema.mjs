// The JSON Schema subset evals/schema/ uses (type, enum, required, properties,
// additionalProperties: false, items, minimum, minLength), so the runner tests
// can check results.json without a dependency. → list of "path: problem" strings.
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const isType = (v, t) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer')

export function validate(schema, value, path = '$') {
  const errs = []
  if (schema.type && ![].concat(schema.type).some((t) => isType(value, t)))
    return [`${path}: expected ${[].concat(schema.type).join('|')}, got ${typeOf(value)}`]
  if (schema.enum && !schema.enum.some((e) => e === value)) errs.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`)
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) errs.push(`${path}: ${value} < ${schema.minimum}`)
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`)
  if (typeOf(value) === 'array' && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)))
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}: missing ${k}`)
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, `${path}.${k}`))
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected property ${k}`)
    }
  }
  return errs
}
