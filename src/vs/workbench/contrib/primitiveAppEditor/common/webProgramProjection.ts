/*---------------------------------------------------------------------------------------------
 *  Primitive App Editor - ASP.NET Core API and Next.js application projection (build.web-program)
 *  Specification SSOT: docs/primitive-app-editor/App Editer.md (31. Web Application Program)
 *--------------------------------------------------------------------------------------------*/

import { ApplicationOutputProjection, IApplicationOutput, projectApplicationOutput } from './applicationOutput.js';
import { IBuildAuthoringData, POSTGRESQL_WEB_APPLICATION_OUTPUT } from './buildValidation.js';
import { IPostgresqlSchema, projectPostgresqlSchema } from './postgresqlProjection.js';

/**
 * ```text
 * Registry + Relation + Function Binding + Renderer Binding + Code Primitive
 *        -> Application Projection -> ASP.NET Core API | Next.js UI -> Application Output
 * ```
 *
 * The Projection is derived only from the Application Output (never from the Editor). Both programs
 * are generic Runtimes over `application.definition.json`, the serialized Application Definition:
 * the C# API connects to PostgreSQL (`Query / CRUD` and `Function Runtime`), and the Next.js UI
 * resolves a Renderer from the result. PostgreSQL identifiers come from the same
 * {@link projectPostgresqlSchema} as `001_init_postgresql.sql`, so DDL and API always agree.
 *
 * Boundary (`App Editor API / Application Language Boundary`): Application-specific Function
 * semantics are the Application's C# responsibility (`IApplicationFunction`); the generated API
 * adds no dedicated Resolver / Primitive to the App Editor and depends on no Editor internals or
 * Node transport. File layout inside the final artifact is `build.deploy`'s.
 */

export const WEB_PROGRAM_DEFINITION_FILE = 'application.definition.json';

/** One generated file, relative to the web program projection root. */
export interface IWebProgramFile {
	readonly path: string;
	readonly content: string;
}

export interface IWebProgramProjection {
	readonly schema: IPostgresqlSchema;
	/** `api/` (ASP.NET Core), `ui/` (Next.js) and the shared Application Definition, sorted by path. */
	readonly files: readonly IWebProgramFile[];
}

// #region Application Definition

/** Serializes the Application Definition (Schema / Binding). Seed Raw Data stays in `002_seed_data.sql`. */
function serializeDefinition(output: IApplicationOutput, schema: IPostgresqlSchema): string {
	const { definition } = output;
	return `${JSON.stringify({
		tables: schema.tables.map(table => ({
			uuid: table.registryUuid,
			schema: table.schema,
			name: table.name,
			columns: table.columns.map(column => ({ uuid: column.registryUuid ?? null, name: column.name, kind: column.kind, notNull: column.notNull, searchable: column.searchable })),
		})),
		relations: definition.schema.relations,
		functions: definition.schema.functions,
		renderers: definition.schema.renderers,
		bindings: {
			functions: definition.binding.functions,
			dependencies: definition.binding.dependencies,
			renderers: definition.binding.renderers,
		},
	}, null, '\t')}\n`;
}

// #endregion

// #region ASP.NET Core API

const API_NAMESPACE = 'PrimitiveApplication.Api';

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk.Web">
\t<PropertyGroup>
\t\t<TargetFramework>net8.0</TargetFramework>
\t\t<Nullable>enable</Nullable>
\t\t<ImplicitUsings>enable</ImplicitUsings>
\t\t<RootNamespace>${API_NAMESPACE}</RootNamespace>
\t</PropertyGroup>
\t<ItemGroup>
\t\t<PackageReference Include="Npgsql" Version="8.0.3" />
\t</ItemGroup>
\t<ItemGroup>
\t\t<Content Include="../${WEB_PROGRAM_DEFINITION_FILE}" Link="${WEB_PROGRAM_DEFINITION_FILE}" CopyToOutputDirectory="PreserveNewest" />
\t</ItemGroup>
</Project>
`;

const APPSETTINGS = `{
\t"ConnectionStrings": {
\t\t"Application": "Host=localhost;Database=application;Username=application;Password="
\t},
\t"Logging": { "LogLevel": { "Default": "Information" } },
\t"AllowedHosts": "*"
}
`;

const DEFINITION_CS = `using System.Text.Json;

namespace ${API_NAMESPACE};

public sealed record ColumnDefinition(string? Uuid, string Name, string Kind, bool NotNull, bool Searchable);

public sealed record TableDefinition(string Uuid, string Schema, string Name, IReadOnlyList<ColumnDefinition> Columns)
{
\tpublic string Qualified => $"{Quote(Schema)}.{Quote(Name)}";

\tpublic static string Quote(string identifier) => "\\"" + identifier.Replace("\\"", "\\"\\"") + "\\"";
}

/// <summary>The Application Definition projected by the Build. The only source of table / column identifiers.</summary>
public sealed class ApplicationDefinition
{
\tpublic IReadOnlyList<TableDefinition> Tables { get; }
\tpublic JsonElement Functions { get; }
\tpublic JsonElement Renderers { get; }
\tpublic JsonElement Bindings { get; }

\tprivate ApplicationDefinition(JsonDocument document)
\t{
\t\tvar root = document.RootElement;
\t\tTables = JsonSerializer.Deserialize<List<TableDefinition>>(root.GetProperty("tables"), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
\t\tFunctions = root.GetProperty("functions").Clone();
\t\tRenderers = root.GetProperty("renderers").Clone();
\t\tBindings = root.GetProperty("bindings").Clone();
\t}

\tpublic static ApplicationDefinition Load(string path)
\t{
\t\tusing var document = JsonDocument.Parse(File.ReadAllText(path));
\t\treturn new ApplicationDefinition(document);
\t}

\tpublic TableDefinition? Find(string schema, string name) => Tables.FirstOrDefault(t => t.Schema == schema && t.Name == name);
}
`;

const TABLE_RUNTIME_CS = `using System.Globalization;
using System.Text.Json;
using Npgsql;
using NpgsqlTypes;

namespace ${API_NAMESPACE};

/// <summary>Query / CRUD against PostgreSQL. Identifiers come only from the Application Definition; values are always parameters.</summary>
public sealed class TableRuntime(NpgsqlDataSource dataSource)
{
\tprivate const string RowIdentity = "uuid";

\tpublic async Task<IReadOnlyList<Dictionary<string, object?>>> SelectAsync(TableDefinition table, CancellationToken cancellation)
\t{
\t\tawait using var command = dataSource.CreateCommand($"SELECT * FROM {table.Qualified} ORDER BY {TableDefinition.Quote(RowIdentity)}");
\t\treturn await ReadAsync(command, cancellation);
\t}

\tpublic async Task<Dictionary<string, object?>?> SelectOneAsync(TableDefinition table, Guid uuid, CancellationToken cancellation)
\t{
\t\tawait using var command = dataSource.CreateCommand($"SELECT * FROM {table.Qualified} WHERE {TableDefinition.Quote(RowIdentity)} = $1");
\t\tcommand.Parameters.AddWithValue(NpgsqlDbType.Uuid, uuid);
\t\treturn (await ReadAsync(command, cancellation)).FirstOrDefault();
\t}

\tpublic async Task InsertAsync(TableDefinition table, Guid uuid, JsonElement values, CancellationToken cancellation)
\t{
\t\tvar columns = table.Columns.Where(c => c.Name != RowIdentity && values.TryGetProperty(c.Name, out _)).ToList();
\t\tvar names = new[] { RowIdentity }.Concat(columns.Select(c => c.Name)).Select(TableDefinition.Quote);
\t\tvar placeholders = Enumerable.Range(1, columns.Count + 1).Select(i => "$" + i);
\t\tawait using var command = dataSource.CreateCommand($"INSERT INTO {table.Qualified} ({string.Join(", ", names)}) VALUES ({string.Join(", ", placeholders)})");
\t\tcommand.Parameters.AddWithValue(NpgsqlDbType.Uuid, uuid);
\t\tforeach (var column in columns)
\t\t{
\t\t\tcommand.Parameters.Add(Parameter(column, values.GetProperty(column.Name)));
\t\t}
\t\tawait command.ExecuteNonQueryAsync(cancellation);
\t}

\tpublic async Task<bool> UpdateAsync(TableDefinition table, Guid uuid, JsonElement values, CancellationToken cancellation)
\t{
\t\tvar columns = table.Columns.Where(c => c.Name != RowIdentity && values.TryGetProperty(c.Name, out _)).ToList();
\t\tif (columns.Count == 0)
\t\t{
\t\t\treturn await SelectOneAsync(table, uuid, cancellation) is not null;
\t\t}
\t\tvar assignments = columns.Select((c, i) => $"{TableDefinition.Quote(c.Name)} = \${i + 1}");
\t\tawait using var command = dataSource.CreateCommand($"UPDATE {table.Qualified} SET {string.Join(", ", assignments)} WHERE {TableDefinition.Quote(RowIdentity)} = \${columns.Count + 1}");
\t\tforeach (var column in columns)
\t\t{
\t\t\tcommand.Parameters.Add(Parameter(column, values.GetProperty(column.Name)));
\t\t}
\t\tcommand.Parameters.AddWithValue(NpgsqlDbType.Uuid, uuid);
\t\treturn await command.ExecuteNonQueryAsync(cancellation) > 0;
\t}

\tpublic async Task<bool> DeleteAsync(TableDefinition table, Guid uuid, CancellationToken cancellation)
\t{
\t\tawait using var command = dataSource.CreateCommand($"DELETE FROM {table.Qualified} WHERE {TableDefinition.Quote(RowIdentity)} = $1");
\t\tcommand.Parameters.AddWithValue(NpgsqlDbType.Uuid, uuid);
\t\treturn await command.ExecuteNonQueryAsync(cancellation) > 0;
\t}

\tprivate static async Task<IReadOnlyList<Dictionary<string, object?>>> ReadAsync(NpgsqlCommand command, CancellationToken cancellation)
\t{
\t\tvar rows = new List<Dictionary<string, object?>>();
\t\tawait using var reader = await command.ExecuteReaderAsync(cancellation);
\t\twhile (await reader.ReadAsync(cancellation))
\t\t{
\t\t\tvar row = new Dictionary<string, object?>();
\t\t\tfor (var i = 0; i < reader.FieldCount; i++)
\t\t\t{
\t\t\t\trow[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
\t\t\t}
\t\t\trows.Add(row);
\t\t}
\t\treturn rows;
\t}

\t/// <summary>Kind Dispatch of the column kind to the PostgreSQL parameter type.</summary>
\tprivate static NpgsqlParameter Parameter(ColumnDefinition column, JsonElement value)
\t{
\t\tif (value.ValueKind == JsonValueKind.Null)
\t\t{
\t\t\treturn new NpgsqlParameter { Value = DBNull.Value };
\t\t}
\t\treturn column.Kind switch
\t\t{
\t\t\t"uuid" => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Uuid, Value = value.GetGuid() },
\t\t\t"int" => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = value.GetInt64() },
\t\t\t"double" => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Double, Value = value.GetDouble() },
\t\t\t"bool" => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Boolean, Value = value.GetBoolean() },
\t\t\t"date" => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Date, Value = DateOnly.Parse(value.GetString()!, CultureInfo.InvariantCulture) },
\t\t\t"timestamp" => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.TimestampTz, Value = DateTimeOffset.Parse(value.GetString()!, CultureInfo.InvariantCulture).UtcDateTime },
\t\t\t"json" => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Jsonb, Value = value.GetRawText() },
\t\t\t_ => new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = value.GetString() },
\t\t};
\t}
}
`;

const REQUEST_VALIDATION_CS = `using System.Globalization;
using System.Text.Json;

namespace ${API_NAMESPACE};

/// <summary>
/// Request Validation for Insert / Update bodies. Rules derive only from the Application Definition (column kind / not_null);
/// every violation is collected so that one 400 ProblemDetails reports them all. Unknown keys are ignored.
/// </summary>
public static class RequestValidation
{
\tprivate const string RowIdentity = "uuid";

\tpublic static Dictionary<string, string[]> Validate(TableDefinition table, JsonElement body, bool isInsert)
\t{
\t\tvar errors = new Dictionary<string, string[]>();
\t\tif (body.ValueKind != JsonValueKind.Object)
\t\t{
\t\t\terrors[""] = ["The request body must be a JSON object."];
\t\t\treturn errors;
\t\t}
\t\tforeach (var column in table.Columns)
\t\t{
\t\t\tvar present = body.TryGetProperty(column.Name, out var value);
\t\t\tif (column.Name == RowIdentity)
\t\t\t{
\t\t\t\tif (present && !IsValid("uuid", value, allowNull: false))
\t\t\t\t{
\t\t\t\t\terrors[column.Name] = ["Must be a UUID string."];
\t\t\t\t}
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (!present)
\t\t\t{
\t\t\t\tif (isInsert && column.NotNull)
\t\t\t\t{
\t\t\t\t\terrors[column.Name] = ["A value is required."];
\t\t\t\t}
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (value.ValueKind == JsonValueKind.Null)
\t\t\t{
\t\t\t\tif (column.NotNull)
\t\t\t\t{
\t\t\t\t\terrors[column.Name] = ["Must not be null."];
\t\t\t\t}
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (!IsValid(column.Kind, value, allowNull: true))
\t\t\t{
\t\t\t\terrors[column.Name] = [Expected(column.Kind)];
\t\t\t}
\t\t}
\t\treturn errors;
\t}

\t/// <summary>Kind Dispatch of the column kind to the accepted JSON type / format (the inverse of TableRuntime.Parameter).</summary>
\tinternal static bool IsValid(string kind, JsonElement value, bool allowNull)
\t{
\t\tif (value.ValueKind == JsonValueKind.Null)
\t\t{
\t\t\treturn allowNull;
\t\t}
\t\treturn kind switch
\t\t{
\t\t\t"uuid" => value.ValueKind == JsonValueKind.String && Guid.TryParse(value.GetString(), out _),
\t\t\t"int" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
\t\t\t"double" => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var d) && double.IsFinite(d),
\t\t\t"bool" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
\t\t\t"date" => value.ValueKind == JsonValueKind.String && DateOnly.TryParse(value.GetString(), CultureInfo.InvariantCulture, out _),
\t\t\t"timestamp" => value.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(value.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.None, out _),
\t\t\t"json" => true,
\t\t\t_ => value.ValueKind == JsonValueKind.String,
\t\t};
\t}

\tprivate static string Expected(string kind) => kind switch
\t{
\t\t"uuid" => "Must be a UUID string.",
\t\t"int" => "Must be a 64-bit integer.",
\t\t"double" => "Must be a finite number.",
\t\t"bool" => "Must be true or false.",
\t\t"date" => "Must be a date string (yyyy-MM-dd).",
\t\t"timestamp" => "Must be a timestamp string (ISO 8601).",
\t\t_ => "Must be a string.",
\t};
}
`;

const FUNCTION_RUNTIME_CS = `using System.Text.Json;

namespace ${API_NAMESPACE};

/// <summary>
/// Application-specific Function. Its semantics are the Application's responsibility; the generated API only
/// resolves it by the <c>executor</c> name of <c>function_registry</c> and invokes it.
/// </summary>
public interface IApplicationFunction
{
\tstring Executor { get; }

\tTask<JsonElement> InvokeAsync(FunctionInvocation invocation, CancellationToken cancellation);
}

public sealed record FunctionInvocation(string Executor, JsonElement Constructor, JsonElement Input, JsonElement Parameters);

/// <summary>Function Runtime: Function Binding -> executor -> result. Register Application Functions in the service container.</summary>
public sealed class FunctionRuntime(ApplicationDefinition definition, IEnumerable<IApplicationFunction> functions)
{
\tprivate readonly Dictionary<string, IApplicationFunction> _functions = functions.ToDictionary(f => f.Executor);

\tpublic async Task<JsonElement?> InvokeBindingAsync(string bindingUuid, JsonElement input, CancellationToken cancellation)
\t{
\t\tvar binding = definition.Bindings.GetProperty("functions").EnumerateArray()
\t\t\t.Where(b => b.GetProperty("uuid").GetString() == bindingUuid).Select(b => (JsonElement?)b).FirstOrDefault();
\t\tif (binding is null)
\t\t{
\t\t\treturn null;
\t\t}
\t\tvar functionUuid = binding.Value.GetProperty("function").GetProperty("uuid").GetString();
\t\tvar entry = definition.Functions.EnumerateArray().First(f => f.GetProperty("uuid").GetString() == functionUuid);
\t\tvar executor = entry.GetProperty("executor").GetString()!;
\t\tif (!_functions.TryGetValue(executor, out var function))
\t\t{
\t\t\tthrow new InvalidOperationException($"No Application Function is registered for executor '{executor}'.");
\t\t}
\t\treturn await function.InvokeAsync(
\t\t\tnew FunctionInvocation(executor, binding.Value.GetProperty("constructor"), input, binding.Value.GetProperty("parameters")),
\t\t\tcancellation);
\t}
}
`;

const PROGRAM_CS = `using System.Text.Json;
using ${API_NAMESPACE};
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(ApplicationDefinition.Load(Path.Combine(AppContext.BaseDirectory, "${WEB_PROGRAM_DEFINITION_FILE}")));
builder.Services.AddSingleton(NpgsqlDataSource.Create(builder.Configuration.GetConnectionString("Application")!));
builder.Services.AddSingleton<TableRuntime>();
builder.Services.AddSingleton<FunctionRuntime>();
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
\t.WithOrigins(builder.Configuration["Ui:Origin"] ?? "http://localhost:3000").AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

// Application Runtime: HTTP Request -> Query / CRUD | Function Runtime -> PostgreSQL -> Result.
app.MapGet("/api/definition", (ApplicationDefinition definition) => Results.Ok(new
{
\ttables = definition.Tables,
\trenderers = definition.Renderers,
\tbindings = definition.Bindings.GetProperty("renderers"),
}));

var tables = app.MapGroup("/api/tables/{schema}/{table}");

tables.MapGet("", async (string schema, string table, ApplicationDefinition definition, TableRuntime runtime, CancellationToken cancellation) =>
\tdefinition.Find(schema, table) is { } t ? Results.Ok(await runtime.SelectAsync(t, cancellation)) : Results.NotFound());

tables.MapGet("{uuid:guid}", async (string schema, string table, Guid uuid, ApplicationDefinition definition, TableRuntime runtime, CancellationToken cancellation) =>
{
\tif (definition.Find(schema, table) is not { } t) { return Results.NotFound(); }
\treturn await runtime.SelectOneAsync(t, uuid, cancellation) is { } row ? Results.Ok(row) : Results.NotFound();
});

tables.MapPost("", async (string schema, string table, JsonElement values, ApplicationDefinition definition, TableRuntime runtime, CancellationToken cancellation) =>
{
\tif (definition.Find(schema, table) is not { } t) { return Results.NotFound(); }
\tif (RequestValidation.Validate(t, values, isInsert: true) is { Count: > 0 } errors) { return Results.ValidationProblem(errors); }
\tvar uuid = values.TryGetProperty("uuid", out var given) ? given.GetGuid() : Guid.NewGuid();
\tawait runtime.InsertAsync(t, uuid, values, cancellation);
\treturn Results.Created($"/api/tables/{schema}/{table}/{uuid}", new { uuid });
});

tables.MapPut("{uuid:guid}", async (string schema, string table, Guid uuid, JsonElement values, ApplicationDefinition definition, TableRuntime runtime, CancellationToken cancellation) =>
{
\tif (definition.Find(schema, table) is not { } t) { return Results.NotFound(); }
\tif (RequestValidation.Validate(t, values, isInsert: false) is { Count: > 0 } errors) { return Results.ValidationProblem(errors); }
\treturn await runtime.UpdateAsync(t, uuid, values, cancellation) ? Results.NoContent() : Results.NotFound();
});

tables.MapDelete("{uuid:guid}", async (string schema, string table, Guid uuid, ApplicationDefinition definition, TableRuntime runtime, CancellationToken cancellation) =>
{
\tif (definition.Find(schema, table) is not { } t) { return Results.NotFound(); }
\treturn await runtime.DeleteAsync(t, uuid, cancellation) ? Results.NoContent() : Results.NotFound();
});

app.MapPost("/api/functions/{binding}", async (string binding, JsonElement input, FunctionRuntime runtime, CancellationToken cancellation) =>
\tawait runtime.InvokeBindingAsync(binding, input, cancellation) is { } result ? Results.Ok(result) : Results.NotFound());

app.Run();
`;

// #endregion

// #region Next.js UI

const UI_PACKAGE_JSON = `${JSON.stringify({
	name: 'primitive-application-ui',
	private: true,
	scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
	dependencies: { next: '14.2.5', react: '18.3.1', 'react-dom': '18.3.1' },
	devDependencies: { '@types/node': '20.14.10', '@types/react': '18.3.3', typescript: '5.5.3' },
}, null, '\t')}\n`;

const UI_TSCONFIG = `${JSON.stringify({
	compilerOptions: {
		target: 'es2022', lib: ['dom', 'esnext'], jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler',
		strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true, isolatedModules: true, incremental: true,
		plugins: [{ name: 'next' }],
	},
	include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
	exclude: ['node_modules'],
}, null, '\t')}\n`;

const UI_NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`;

const UI_API_TS = `export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:5000';

export interface RendererInput {
\treadonly name: string;
\treadonly kind: string;
}

export interface RendererDefinition {
\treadonly uuid: string;
\treadonly name: string;
\treadonly label?: string;
\treadonly executor: string;
\treadonly inputs: readonly RendererInput[];
}

export interface RendererBinding {
\treadonly uuid: string;
\treadonly renderer: { readonly uuid: string };
\treadonly bindings: Readonly<Record<string, { readonly address?: { table_uuid: string; row_uuid: string; column_uuid: string }; readonly asset_uuid?: string }>>;
}

export interface TableDefinition {
\treadonly uuid: string;
\treadonly schema: string;
\treadonly name: string;
\treadonly columns: readonly { uuid: string | null; name: string; kind: string }[];
}

export interface ApplicationDefinition {
\treadonly tables: readonly TableDefinition[];
\treadonly renderers: readonly RendererDefinition[];
\treadonly bindings: readonly RendererBinding[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
\tconst response = await fetch(\`\${API_BASE}\${path}\`, { cache: 'no-store', ...init });
\tif (!response.ok) {
\t\tthrow new Error(\`\${init?.method ?? 'GET'} \${path} failed: \${response.status}\`);
\t}
\treturn response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

export const getDefinition = () => request<ApplicationDefinition>('/api/definition');
export const selectRows = (table: Pick<TableDefinition, 'schema' | 'name'>) =>
\trequest<Record<string, unknown>[]>(\`/api/tables/\${encodeURIComponent(table.schema)}/\${encodeURIComponent(table.name)}\`);
`;

const UI_RENDERERS_TSX = `import type { ReactNode } from 'react';
import type { RendererBinding, RendererDefinition, TableDefinition } from './api';

export interface RendererProps {
\treadonly renderer: RendererDefinition;
\treadonly binding: RendererBinding;
\t/** Result of the PostgreSQL query for each bound Persistent Address, keyed by renderer input name. */
\treadonly values: Readonly<Record<string, unknown>>;
}

export type RendererComponent = (props: RendererProps) => ReactNode;

/**
 * Renderer Registry of the UI: \`renderer_registry.executor\` -> component. The Application registers
 * its own components here; an unregistered executor falls back to the generic JSON view.
 */
export const rendererComponents: Record<string, RendererComponent> = {};

export function GenericRenderer({ renderer, values }: RendererProps): ReactNode {
\treturn (
\t\t<section>
\t\t\t<h2>{renderer.label ?? renderer.name}</h2>
\t\t\t<pre>{JSON.stringify(values, null, 2)}</pre>
\t\t</section>
\t);
}

/** Resolves the bound value of each input from the queried rows (Persistent Address: table / row / column uuid). */
export function resolveValues(binding: RendererBinding, tables: readonly TableDefinition[], rows: Readonly<Record<string, readonly Record<string, unknown>[]>>): Record<string, unknown> {
\tconst values: Record<string, unknown> = {};
\tfor (const [input, bound] of Object.entries(binding.bindings)) {
\t\tif (bound.asset_uuid !== undefined) {
\t\t\tvalues[input] = { asset_uuid: bound.asset_uuid };
\t\t\tcontinue;
\t\t}
\t\tconst address = bound.address;
\t\tconst table = tables.find(t => t.uuid === address?.table_uuid);
\t\tconst column = table?.columns.find(c => c.uuid === address?.column_uuid);
\t\tconst row = table && rows[table.uuid]?.find(r => r['uuid'] === address?.row_uuid);
\t\tvalues[input] = column && row ? row[column.name] : null;
\t}
\treturn values;
}
`;

const UI_LAYOUT_TSX = `import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
\treturn (
\t\t<html lang="en">
\t\t\t<body>{children}</body>
\t\t</html>
\t);
}
`;

const UI_PAGE_TSX = `import { getDefinition, selectRows } from '../lib/api';
import { GenericRenderer, rendererComponents, resolveValues } from '../lib/renderers';

export const dynamic = 'force-dynamic';

// Result -> Renderer: query the bound tables through the C# API, then render each Renderer Binding.
export default async function Page() {
\tconst definition = await getDefinition();
\tconst used = new Set(definition.bindings.flatMap(b => Object.values(b.bindings).map(v => v.address?.table_uuid)));
\tconst rows: Record<string, Record<string, unknown>[]> = {};
\tfor (const table of definition.tables.filter(t => used.has(t.uuid))) {
\t\trows[table.uuid] = await selectRows(table);
\t}
\treturn (
\t\t<main>
\t\t\t{definition.bindings.map(binding => {
\t\t\t\tconst renderer = definition.renderers.find(r => r.uuid === binding.renderer.uuid);
\t\t\t\tif (!renderer) {
\t\t\t\t\treturn null;
\t\t\t\t}
\t\t\t\tconst Component = rendererComponents[renderer.executor] ?? GenericRenderer;
\t\t\t\tconst values = resolveValues(binding, definition.tables, rows);
\t\t\t\treturn <Component key={binding.uuid} renderer={renderer} binding={binding} values={values} />;
\t\t\t})}
\t\t</main>
\t);
}
`;

// #endregion

/** `build_target` 'PostgreSQL Web Application Output': Application Output -> ASP.NET Core API + Next.js UI. */
export const webProgramApplicationOutputProjection: ApplicationOutputProjection<IWebProgramProjection> = (output: IApplicationOutput) => {
	const schema = projectPostgresqlSchema(output.definition.schema.tables);
	const files: IWebProgramFile[] = [
		{ path: WEB_PROGRAM_DEFINITION_FILE, content: serializeDefinition(output, schema) },
		{ path: 'api/PrimitiveApplication.Api.csproj', content: CSPROJ },
		{ path: 'api/appsettings.json', content: APPSETTINGS },
		{ path: 'api/ApplicationDefinition.cs', content: DEFINITION_CS },
		{ path: 'api/TableRuntime.cs', content: TABLE_RUNTIME_CS },
		{ path: 'api/RequestValidation.cs', content: REQUEST_VALIDATION_CS },
		{ path: 'api/FunctionRuntime.cs', content: FUNCTION_RUNTIME_CS },
		{ path: 'api/Program.cs', content: PROGRAM_CS },
		{ path: 'ui/package.json', content: UI_PACKAGE_JSON },
		{ path: 'ui/tsconfig.json', content: UI_TSCONFIG },
		{ path: 'ui/next.config.mjs', content: UI_NEXT_CONFIG },
		{ path: 'ui/lib/api.ts', content: UI_API_TS },
		{ path: 'ui/lib/renderers.tsx', content: UI_RENDERERS_TSX },
		{ path: 'ui/app/layout.tsx', content: UI_LAYOUT_TSX },
		{ path: 'ui/app/page.tsx', content: UI_PAGE_TSX },
	];
	files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return Object.freeze({ schema, files: Object.freeze(files.map(file => Object.freeze(file))) });
};

/** The Application Output Projections of `build.web-program`, keyed by `build_target`. */
export const webProgramApplicationOutputProjections: ReadonlyMap<string, ApplicationOutputProjection<IWebProgramProjection>> = new Map([
	[POSTGRESQL_WEB_APPLICATION_OUTPUT, webProgramApplicationOutputProjection],
]);

/** `Authoring Data + Build Configuration -> Build Validation -> Build Target Filter -> Application Output -> Web Program Projection`. */
export function projectWebProgramApplicationOutput(authoring: IBuildAuthoringData, input: unknown): { readonly output: IApplicationOutput; readonly result: IWebProgramProjection } {
	return projectApplicationOutput(authoring, input, webProgramApplicationOutputProjections);
}
