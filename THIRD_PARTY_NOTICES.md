# Third-party notices

## Existing UI dependencies reviewed for this change

No new runtime dependency was added. The existing maintained, permissively
licensed stack already covers the accessible primitives, iconography and
Markdown rendering needed by this UI slice:

| Package | Version | License | Upstream | Files used here | Reason retained |
| --- | --- | --- | --- | --- | --- |
| Base UI | 1.7.0 | MIT | https://github.com/mui/base-ui | `src/components/ui/button.tsx`, `tooltip.tsx`, `scroll-area.tsx`, `thinking-steps.tsx` | Accessible unstyled interaction primitives without replacing the shell. |
| Phosphor Icons React | 2.1.10 | MIT | https://github.com/phosphor-icons/react | `src/components/chat-workspace.tsx`, `turn-activity.tsx`, `details-panel.tsx` | One coherent, reusable icon set for light/dark UI. |
| react-markdown | 10.1.0 | MIT | https://github.com/remarkjs/react-markdown | `src/components/markdown-message.tsx` | Structured React rendering instead of unsafe HTML assembly. |
| remark-gfm | 4.0.1 | MIT | https://github.com/remarkjs/remark-gfm | `src/components/markdown-message.tsx` | Small GFM extension for tables, task lists and strikethrough. |

The installed package metadata and each upstream repository were checked on
2026-08-30. Adding another composer, streaming or shell dependency would
duplicate current capabilities and increase integration risk, so the focused
improvements use the existing components.

## assistant-ui

Selected presentation patterns in the AI Brain chat interface were adapted from
the `assistant-ui` ChatGPT example and thread shell:

- `apps/docs/components/pages/examples/chatgpt.tsx`
- `apps/docs/components/pages/examples/clone-thread-shell.tsx`

Copyright (c) 2025 AgentbaseAI Inc.

Licensed under the MIT License:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
