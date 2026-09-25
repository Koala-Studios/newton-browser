# Model-directed MDN task, packed v48

Goal: open MDN site search and find fetch documentation by choosing actions from
returned controls/images. The task did not complete; the failures are retained.

Used the extracted packed public MCP handler interactively in Node, not direct DOM
or network access for the task. This excludes stdio framing overhead. Raw public
calls, results, tool latency and text-token counts are in `astra-model-v48.json`;
two clipped screenshots are `astra-model-v48-image-5.png` and `...-6.png`.

- Nine public calls, 4,708 returned text tokens, plus two viewed images (image tokens
  and model reasoning are not counted). No fixed sleeps or wait_for commands.
- Initial SDK host with a spread Windows environment failed in about2ms. Read-only
  diagnosis found configured_browser_unavailable; mixed-case ProgramFiles keys were
  lost by uppercase-only lookup. Using the native process.env map allowed startup.
- MDN returned Search button ref e2, but clicking it was refused target_moved before
  input. The default screenshot then failed output_budget. Two bounded clips exposed
  the visible search icon; a capture-bound coordinate click opened search and returned
  the Search combobox as ref e82.
- Filling that returned combobox failed stale_target after focus acknowledgement.
  The receipt's local feedback showed the field still empty. The model did not blindly
  replay the uncertain action; it stopped the session and investigated the code.
- Deterministic shadow-input fixtures reproduce the click failure in verifyHit and
  then the fill failure in focusedFacts. Candidate fixes now traverse containing shadow
  roots for hit verification and inspect focus within the leaf's own tree. Native
  focused-target discovery follows authored shadow roots, including closed ones.
- `astra-shadow-input-fixed-e.log` verifies actual click and alpha-beta input effects
  for open and closed roots. Live MDN replay against the fixed packed code is pending.
  Default screenshot output-budget usability also remains open.

Public session stop and host close completed. Node REPL exited. Automatic approval
review rejected recursive deletion of the exact temporary extraction/config directory
with "blocked by policy"; it remains at
`C:\Users\<user>\AppData\Local\Temp\newton-model-qa-2c69914fdbce4fa6ae288755dd36e38c`.
No alternate deletion method was attempted. This is not full release acceptance or
a ChatGPT parity benchmark.
