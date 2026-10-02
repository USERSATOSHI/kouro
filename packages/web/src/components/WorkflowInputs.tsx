import { Fieldset, NativeSelect, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { validateJsonSchema, type Bundle, type JsonValue } from "@kouro/core";

type Schema = {
  type?: string;
  enum?: JsonValue[];
  properties?: Record<string, JsonValue>;
  required?: string[];
  description?: string;
};

export function launchInputs(
  bundle: Bundle | undefined,
  task: string,
  drafts: Record<string, string>,
) {
  const input: Record<string, JsonValue> = {};
  const errors: Record<string, string> = {};
  for (const port of bundle?.definitions[bundle.rootDefinitionId]?.inputPorts ?? []) {
    const schema = bundle!.schemas[port.schemaDigest] ?? {};
    const raw = port.name === "task" ? task.trim() : drafts[port.name];
    if (raw === undefined || raw === "") {
      if (port.required && port.defaultValue === undefined) errors[port.name] = "Required";
      continue;
    }
    try {
      const value = (schema as Schema).type === "string" ? raw : JSON.parse(raw);
      const validation = validateJsonSchema(value, schema);
      if (!validation.valid) errors[port.name] = validation.error;
      else input[port.name] = value;
    } catch {
      errors[port.name] = "Enter a valid value";
    }
  }
  return { input, errors, valid: Object.keys(errors).length === 0 };
}

function SchemaField({
  name,
  schema,
  raw,
  onChange,
  required,
}: {
  name: string;
  schema: JsonValue;
  raw: string;
  onChange: (value: string) => void;
  required: boolean;
}) {
  const shape = schema as Schema;
  if (shape.type === "object" && shape.properties) {
    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(raw || "{}");
    } catch {
      /* Preserve invalid input in the complex editor. */
    }
    return (
      <Fieldset
        legend={
          <>
            {name}
            {required ? " · required" : " · optional"}
          </>
        }
        className="workflow-input-object"
      >
        {Object.entries(shape.properties).map(([key, property]) => (
          <SchemaField
            key={key}
            name={`${name}.${key}`}
            schema={property}
            required={shape.required?.includes(key) ?? false}
            raw={
              values[key] === undefined
                ? ""
                : (property as Schema).type === "string"
                  ? String(values[key])
                  : JSON.stringify(values[key])
            }
            onChange={(value) => {
              const next = { ...values };
              if (!value) delete next[key];
              else if ((property as Schema).type === "string") next[key] = value;
              else {
                try {
                  next[key] = JSON.parse(value);
                } catch {
                  return;
                }
              }
              onChange(Object.keys(next).length ? JSON.stringify(next) : "");
            }}
          />
        ))}
      </Fieldset>
    );
  }
  const label = `${name}${required ? " · required" : " · optional"}`;
  return (
    <Stack gap={4} component="label" className="task-input">
      <Text component="span" size="sm">
        {label}
      </Text>
      {shape.enum ? (
        <NativeSelect
          aria-label={name}
          value={raw}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a value…</option>
          {shape.enum.map((value, index) => (
            <option
              key={index}
              value={shape.type === "string" ? String(value) : JSON.stringify(value)}
            >
              {String(value)}
            </option>
          ))}
        </NativeSelect>
      ) : shape.type === "boolean" ? (
        <NativeSelect
          aria-label={name}
          value={raw}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a value…</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </NativeSelect>
      ) : ["number", "integer"].includes(shape.type ?? "") ? (
        <TextInput
          aria-label={name}
          type="number"
          step={shape.type === "integer" ? 1 : "any"}
          value={raw}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Textarea
          aria-label={name}
          rows={shape.type === "string" ? 2 : 4}
          value={raw}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            shape.type === "string" ? "Enter a value…" : "Enter a JSON value for this input…"
          }
        />
      )}
      {shape.description && (
        <Text component="span" size="xs" c="dimmed">
          {shape.description}
        </Text>
      )}
    </Stack>
  );
}

export function WorkflowInputs({
  bundle,
  drafts,
  onChange,
  errors,
}: {
  bundle?: Bundle;
  drafts: Record<string, string>;
  onChange: (drafts: Record<string, string>) => void;
  errors: Record<string, string>;
}) {
  return (
    <Stack gap="xs" component="section" className="workflow-inputs" aria-label="Workflow inputs">
      {(bundle?.definitions[bundle.rootDefinitionId]?.inputPorts ?? [])
        .filter((port) => port.name !== "task")
        .map((port) => (
          <Stack gap="xs" key={port.name}>
            <SchemaField
              name={port.name}
              schema={bundle!.schemas[port.schemaDigest] ?? {}}
              raw={drafts[port.name] ?? ""}
              required={port.required && port.defaultValue === undefined}
              onChange={(value) => onChange({ ...drafts, [port.name]: value })}
            />
            {drafts[port.name] && errors[port.name] && (
              <Text size="sm" role="alert" className="session-error">
                {port.name}: {errors[port.name]}
              </Text>
            )}
          </Stack>
        ))}
    </Stack>
  );
}
