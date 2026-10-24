// An API as Effect's HttpApi defines one, with the shapes the generator reads: the source of the
// golden Swift client, NotesAPI.swift, and of what its server sends and takes, wire.json.
import { DateTime, Effect, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/http-api"

const NoteId = Schema.String.pipe(Schema.brand("NoteId")).annotate({ identifier: "NoteId" })
const Color = Schema.Literals(["red", "green", "1m"]).annotate({ identifier: "Color" })

export class Note extends Schema.Class<Note>("Note")({
  id: NoteId,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  color: Color,
  tags: Schema.Array(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  views: Schema.Int,
  score: Schema.Number,
  extra: Schema.Record(Schema.String, Schema.Number),
  meta: Schema.optional(Schema.Json),
  archivedAt: Schema.optional(Schema.DateTimeUtcFromString),
  rank: Schema.optionalKey(Schema.NullOr(Schema.Int)),
}) {}

const Circle = Schema.TaggedStruct("Circle", { radius: Schema.Number }).annotate({ identifier: "Circle" })
const Square = Schema.TaggedStruct("Square", { side: Schema.Number }).annotate({ identifier: "Square" })
const Shape = Schema.Union([Circle, Square]).annotate({ identifier: "Shape" })

export const NewNote = Schema.Struct({
  title: Schema.String,
  body: Schema.optional(Schema.String),
  color: Color,
  shape: Shape,
  stamp: Circle,
}).annotate({ identifier: "NewNote" })

export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()(
  "NoteNotFound",
  { id: NoteId },
  { httpApiStatus: 404 },
) {}
export class NotAllowed extends Schema.TaggedError<NotAllowed>()(
  "NotAllowed",
  { reason: Schema.String },
  { httpApiStatus: 403 },
) {}

const Notes = HttpApiGroup.make("notes")
  .add(
    HttpApiEndpoint.get("listNotes", "/notes", {
      query: {
        since: Schema.optional(Schema.DateTimeUtcFromString),
        limit: Schema.optional(Schema.Int),
        color: Schema.optional(Color),
        q: Schema.optional(Schema.String),
      },
      success: Schema.Array(Note),
    }),
  )
  .add(HttpApiEndpoint.get("getNote", "/notes/:id", { params: { id: NoteId }, success: Note, error: NoteNotFound }))
  .add(
    HttpApiEndpoint.post("createNote", "/notes", {
      payload: NewNote,
      success: Note,
      error: [NotAllowed, HttpApiError.BadRequest],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteNote", "/notes/:id", { params: { id: NoteId }, error: [NoteNotFound, NotAllowed] }),
  )

/** The API's OpenAPI document, as Effect writes it. */
export const notesDocument = OpenApi.fromApi(HttpApi.make("Notes").add(Notes).annotate(OpenApi.Title, "Notes"))

const encoded = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(value).pipe(Effect.orDie)

/** What the API's server sends and takes, as Effect encodes it: the Swift round trip reads it. */
export const wire = Effect.gen(function* () {
  const groceries = new Note({
    id: NoteId.make("n/1"),
    title: "Groceries",
    body: null,
    pinned: true,
    color: "green",
    tags: ["home", "to do"],
    createdAt: DateTime.makeUnsafe("2026-10-24T09:30:00.000Z"),
    views: 3,
    score: Number.NEGATIVE_INFINITY,
    extra: { weight: 2.5, peak: Number.POSITIVE_INFINITY },
    meta: { nested: [1, "two", null, true] },
    archivedAt: DateTime.makeUnsafe("2026-10-25T00:00:00.000Z"),
    rank: 7,
  })
  const ideas = new Note({
    id: NoteId.make("n2"),
    title: "Ideas",
    body: "Write the kit",
    pinned: false,
    color: "1m",
    tags: [],
    createdAt: DateTime.makeUnsafe("2026-10-23T12:00:00.000Z"),
    views: 0,
    score: 0.5,
    extra: {},
  })
  return {
    notes: yield* encoded(Schema.Array(Note), [groceries, ideas]),
    note: yield* encoded(Note, ideas),
    newNote: yield* encoded(NewNote, {
      title: "Draft",
      color: "red",
      shape: { _tag: "Square", side: 2 },
      stamp: { _tag: "Circle", radius: Number.NaN },
    }),
    noteNotFound: yield* encoded(NoteNotFound, new NoteNotFound({ id: NoteId.make("missing") })),
    notAllowed: yield* encoded(NotAllowed, new NotAllowed({ reason: "Read only" })),
    badRequest: yield* encoded(HttpApiError.BadRequest, new HttpApiError.BadRequest()),
  }
})
