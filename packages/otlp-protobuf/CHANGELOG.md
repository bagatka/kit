# Changelog

## 0.1.0

First version: `decodeTraces` and `decodeLogs` read OTLP/HTTP protobuf exports of traces and logs,
every field of OTLP 1.x; `encodeTraces` and `encodeLogs` write such data back, losslessly; and
`exportResponse` writes the answer to an export.
