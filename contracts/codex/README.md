# Codex protocol contracts

`0.162.1/` is the single authoritative generated protocol tree used by the
application transport, runtime validators and TypeScript consumers. The runtime
binary, contract generator and contract verification remain pinned to that same
version. Do not hand-edit generated types or JSON Schemas.

- `npm run contracts:generate` regenerates the pinned version.
- `npm run contracts:verify` compares every generated file with the pinned CLI.
- `tests/contract/codex-version.test.ts` checks the runtime pin, required aggregate
  schemas and the single-version invariant.

The retired `0.149.1`, `0.153.4` and `0.156.1` trees remain recoverable from Git
history at baseline `99911eb37fe671dd4f2fd945204cd6fca45cedd5`. Their removal changes
no runtime validator or protocol negotiation: both already used `0.162.1`.
Historical test receipts and documentation retain their original version labels;
they are evidence of their recorded revision, never acceptance of this change.
