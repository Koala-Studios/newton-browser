/** Explain the first way tool arguments break the tool's published input schema,
 * so a model can correct its call. Covers the schema features the catalog uses. */
type Schema = Record<string, unknown>;
export type ArgumentIssue = Readonly<{ field: string; expected: string }>;

export function explainArguments(schema: unknown, value: unknown): ArgumentIssue | undefined {
  return check(object(schema), value, "arguments");
}

function check(schema: Schema, value: unknown, path: string): ArgumentIssue | undefined {
  if ("const" in schema) return value === schema.const ? undefined : { field: path, expected: JSON.stringify(schema.const) };
  if (Array.isArray(schema.enum)) return schema.enum.includes(value) ? undefined : { field: path, expected: `one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}` };
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !hasType(value, type)) return { field: path, expected: type };
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return { field: path, expected: `string of at least ${schema.minLength} characters` };
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return { field: path, expected: `string of at most ${schema.maxLength} characters` };
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return { field: path, expected: `number >= ${schema.minimum}` };
    if (typeof schema.maximum === "number" && value > schema.maximum) return { field: path, expected: `number <= ${schema.maximum}` };
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return { field: path, expected: `at least ${schema.minItems} items` };
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return { field: path, expected: `at most ${schema.maxItems} items` };
    if (schema.items) for (const [index, item] of value.entries()) { const issue = check(object(schema.items), item, `${path}[${index}]`); if (issue) return issue; }
  }
  if (isRecord(value)) {
    const properties = object(schema.properties);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) {
      if (!(key in properties)) return { field: `${path}.${key}`, expected: `not allowed here; allowed: ${Object.keys(properties).join(", ")}` };
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === "string" && !(key in value)) return { field: `${path}.${key}`, expected: "required" };
    }
    for (const [key, item] of Object.entries(value)) {
      if (!(key in properties)) continue;
      const issue = check(object(properties[key]), item, `${path}.${key}`);
      if (issue) return issue;
    }
  }
  if (Array.isArray(schema.oneOf)) return variants(schema.oneOf.map(object), value, path);
  if (Array.isArray(schema.anyOf) && schema.anyOf.every(item => Array.isArray(object(item).required))) {
    const options = schema.anyOf.map(item => (object(item).required as unknown[]).join(" and "));
    if (isRecord(value) && !schema.anyOf.some(item => (object(item).required as string[]).every(key => key in value))) return { field: path, expected: `one of: ${options.join("; ")}` };
  }
  return undefined;
}

function variants(options: Schema[], value: unknown, path: string): ArgumentIssue | undefined {
  // Choose by a constant discriminator (kind, mode) when the value names one.
  if (isRecord(value)) for (const key of ["kind", "mode"]) {
    const labelled = options.filter(option => "const" in object(object(option.properties)[key]) || Array.isArray(object(object(option.properties)[key]).enum));
    if (!labelled.length || !(key in value)) continue;
    const match = labelled.find(option => { const discriminator = object(object(option.properties)[key]); return discriminator.const === value[key] || (Array.isArray(discriminator.enum) && discriminator.enum.includes(value[key])); });
    if (!match) return { field: `${path}.${key}`, expected: `one of ${labelled.flatMap(option => { const discriminator = object(object(option.properties)[key]); return "const" in discriminator ? [discriminator.const] : discriminator.enum as unknown[]; }).map(item => JSON.stringify(item)).join(", ")}` };
    return check(match, value, path);
  }
  const issues = options.map(option => check(option, value, path));
  if (issues.some(issue => !issue)) return undefined;
  return issues.reduce((deepest, issue) => (issue!.field.length > deepest!.field.length ? issue : deepest));
}

function hasType(value: unknown, type: string): boolean {
  return type === "object" ? isRecord(value) : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function object(value: unknown): Schema { return isRecord(value) ? value : {}; }
