# Prompting guide: Kimi K3.1

Every point of Moonshot's guides for Kimi K3.1 that bears on instruction text, with the page and section it comes from. A translation of `requirements/` into this family's folder follows this guide: apply each point that fits the file, and treat the points tagged PARAM or LOOP as the integration's concern unless a file's requirement names them.

Tags: PARAM is a request parameter or API-contract rule, PROMPT is prompt-writing guidance, LOOP is agent-loop or tool-design guidance. The pages give no anchors, so a source is a page and a section heading.

## Pages

| Label | Page                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------- |
| P1    | Best Practices for Prompts: `platform.kimi.ai/docs/guide/prompt-best-practice`                            |
| P2    | Kimi K3.1 Pro quickstart: `platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart`                          |
| P3    | Build an Agent with Kimi K3: `platform.kimi.ai/docs/guide/use-kimi-k3-to-setup-agent`                     |
| P4    | Kimi K3 API Tool Calling Best Practices: `platform.kimi.ai/docs/guide/kimi-k3-tool-calling-best-practice` |

## Points

### P1

- K1 (P1, PROMPT): Make instructions explicit, because "the model can't read your mind". Ask for brevity if output is too long, expert-level writing if too simple, and show the format you want. The less the model guesses, the better the result. Section "Write Clear Instructions".
- K2 (P1, PROMPT): Include all important details and context in the request. Section "Including More Details in Your Request Can Yield More Relevant Responses". The page contrasts a vague request with a specific one.
- K3 (P1, PROMPT): Assign a role in the `messages` system message. Section "Requesting the Model to Assume a Role Can Yield More Accurate Output".
- K4 (P1, PROMPT): Use delimiters (triple quotes, XML tags, section headings) to separate parts of the input that need different handling. Section "Using Delimiters in Your Request to Clearly Distinguish Different Parts of the Input".
- K5 (P1, PROMPT): Spell out the steps of a task explicitly, because explicit steps are easier to follow and give better output. Section "Clearly Define the Steps Needed to Complete the Task".
- K6 (P1, PROMPT): Give examples of the desired output (few-shot). General guidance with examples is "usually more efficient than showing all permutations of the task", and few-shot suits styles that are hard to describe. Section "Provide Examples of Desired Output to the Model".
- K7 (P1, PROMPT): Specify output length, in words, sentences, paragraphs or bullets. Word counts are "not highly precise", and the model is better at a set number of paragraphs or bullets. Section "Specify the Desired Length of the Model's Output".
- K8 (P1, PROMPT): Supply credible reference text and tell the model to answer from it. Give a fallback such as "I can't find the answer" when the answer is absent. Section "Guide the Model to Use Reference Text to Answer Questions".
- K9 (P1, PROMPT): For tasks with many independent instruction sets, classify the query type first. Then give only the instructions relevant to that class. Section "Categorize to Identify Instructions Relevant to User Queries".
- K10 (P1, LOOP): In long dialogs, summarize or filter earlier turns because context is fixed. Summarize past rounds once a size threshold is hit, and carry the summary in the system message, or summarize asynchronously. Section "For Long-Running Dialog Applications, Summarize or Filter Previous Conversations".
- K11 (P1, LOOP): For long documents, summarize chunk by chunk and then recursively summarize the summaries. Include summaries of earlier chapters when a later part depends on them. Section "Chunk and Recursively Build a Complete Summary for Long Documents".

### P2

- K12 (P2, PARAM): Thinking is always on and cannot be disabled. Section "FAQ" ("How do I turn off Kimi K3.1 Pro's chain-of-thought?").
- K13 (P2, PARAM): Set the top-level `reasoning_effort` to `low`, `high` or `max`, default `max`. Use `low` if reasoning takes too long. Sections "Reasoning effort", "Important limits" and "FAQ".
- K14 (P2, PARAM): Return the complete assistant message unchanged on later turns, including `reasoning_content`, and not only `content`. Sections "Reasoning effort" and "Important limits".
- K15 (P2, PARAM): `temperature=1.0`, `top_p=0.95`, `n=1`, `presence_penalty=0` and `frequency_penalty=0` are fixed, so omit them. Section "Important limits".
- K16 (P2, PARAM): `max_completion_tokens` defaults to 131072 and can be raised to 1048576. Section "Important limits".
- K17 (P2, PARAM): Streaming yields separate `reasoning_content` and `content` deltas. Section "Streaming".
- K18 (P2, PARAM): Use `response_format` with `json_schema` and `strict: true`. Parse only `message.content`, never `reasoning_content`. Section "Structured output".
- K19 (P2, PARAM): Vision `content` must be an array of objects, not a serialized string. Public image URLs are unsupported, so use base64 or `ms://`. Sections "Vision input" and "Partial Mode".
- K20 (P2, PARAM): Partial mode adds a final assistant message with `partial=True`. Prepend the prefix yourself when displaying the result. Sections "Vision input" and "Partial Mode".
- K21 (P2, PARAM): Use `tool_choice="required"` on the first turn to force at least one tool call. After executing the calls, return the complete assistant message plus one tool result per call with the matching `tool_call_id`. Section "Custom tools and `tool_choice`".
- K22 (P2, PARAM): A `system` message carrying `tools` and no `content` makes the tool available from its position onward. Include the full `name`, `description` and `parameters`, and keep the message in later history because the server does not retain it. Section "Dynamic tool loading".
- K23 (P2, PARAM): Caching is automatic. TTL is `5m` by default, or `1h` via `prompt_cache_options.ttl` when gaps exceed 5 minutes. Partial cache blocks bill as misses. Section "1M context and TTL caching".
- K24 (P2, LOOP): Official tools go through Formula: fetch `/tools`, add the definitions to `tools`, execute calls via `/fibers`, then return the tool message. Web search is "not recommended" in the near term. Section "Official tools".

### P3

- K25 (P3, LOOP): Split work into retrieve, analyze and deliver before choosing tools or writing prompts. Let the model plan and judge while tools handle retrieval and deterministic work. Avoid repeating tool behavior in a long system prompt. Section "Break Down the Task".
- K26 (P3, LOOP): Use JSON Schema with `additionalProperties: false` and listed `required` fields to reduce invalid arguments. Section "Design Tools".
- K27 (P3, LOOP): For dozens or hundreds of tools, do not send every schema each request. Retrieve candidates first and load them dynamically. Section "Design Tools".
- K28 (P3, PROMPT): Keep the system prompt on role, workflow and quality boundaries, and leave argument details in the tool schema. Section "Design the Prompt". The example prompt does the following:
  - Separate facts, estimates and inferences.
  - Support key findings with multiple sources.
  - Never fabricate data or sources, and state gaps when evidence is insufficient.
  - Name the required report sections.
  - Answer in the user's language.
- K29 (P3, PROMPT): Add constraints incrementally as format, compliance or audience change. Section "Design the Prompt".
- K30 (P3, PARAM): Always append the complete SDK assistant message to `messages`. Copying only `content` and `tool_calls` drops `reasoning_content` and "breaks the context needed by later tool calls". This is repeated as mandatory under "Complete Agent Loop". Section "Configure the K3 API".
- K31 (P3, LOOP): Every tool message must carry the matching `tool_call_id`. Section "Complete Agent Loop".
- K32 (P3, LOOP): Cap tool rounds. The example uses `MAX_TOOL_ROUNDS = 8` in a loop, not recursion. Section "Complete Agent Loop".
- K33 (P3, LOOP): Fail on `finish_reason="length"` instead of treating truncated output as final. Section "Complete Agent Loop".
- K34 (P3, LOOP): When one tool call fails, return its error as that call's tool result and continue the other calls in the round. Section "Complete Agent Loop".
- K35 (P3, LOOP): If the round cap is hit, check for overlapping tool descriptions and ambiguous results, then narrow the task. Section "Run and Troubleshoot".
- K36 (P3, LOOP): For repeated argument errors, fix the schema (`required`, `enum`, `additionalProperties`). "Do not replace argument constraints with prompt text". Section "Run and Troubleshoot".
- K37 (P3, LOOP): Expose only the tools the current task needs, and avoid overlapping tools. Section "Custom Tools and Optimization".
- K38 (P3, LOOP): Validate tool inputs in the application and return structured errors so the model can correct its arguments. Section "Custom Tools and Optimization".
- K39 (P3, PARAM): Check the tool-calling guide and the Model Parameter Reference before using `tool_choice` or reasoning effort. Section "Custom Tools and Optimization".

### P4

- K40 (P4, LOOP): With a large inventory, declare only a backend-implemented `search_tools` plus a few core tools. Large inventories "eat up context" and make wrong-tool picks more likely. Section "Declare a search tool, not all your tools".
- K41 (P4, PROMPT): Advertise the searchable domain tags in the system prompt so the model calls `search_tools` first. Section "Declare a search tool, not all your tools".
- K42 (P4, PARAM): Set `tool_choice: "required"` on the first turn so the model does not answer from memory. Switch back to `"auto"` afterward. Changing `tool_choice` does not invalidate the prefix cache. Section "Use tool_choice to force first-turn retrieval".
- K43 (P4, PARAM): Insert the matched tools' full declarations through a `system` message with a `tools` field. They are visible from that position, use the same format as top-level `tools`, and coexist with them. Section "Inject tool definitions on demand".
- K44 (P4, PARAM): Declarations are per request and not retained by the server. Keep the original declaration in later requests to keep the tool callable and the prefix cache reusable. If it is dropped, the model cannot call the tool and the cache may miss. Section "Inject tool definitions on demand".
- K45 (P4, PARAM): `reasoning_effort` is `low`, `high` or `max` (default `max`). Decide it before the conversation starts. Appending a tool declaration at the end of `messages` does not affect the cached prefix. Removing or changing an earlier declaration may break cache hits after that point. Section "Pick the reasoning effort for the task".

## Related pages

Cited by the four pages and read for their facts; the facts are not numbered points.

- `platform.kimi.ai/docs/guide/use-tool-choice`: `"required"` forces at least one call, `"none"` gives text only and saves latency and tokens, `"auto"` is the default. A function object forces a specific tool but returns 400 with thinking enabled, so it is unusable on K3.1 Pro, which always thinks.
- `platform.kimi.ai/docs/guide/use-dynamic-tool-loading`: append a tool declaration, never insert one, to keep the cache; pin core tools at the top level. It works only on `kimi-k3.1-pro` and `kimi-k3`, and on `kimi-k2.6` it fails with a tokenization error. A `system` message with `tools` plus `content` returns 400.
- `platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls`: every `tool_call` needs a `role=tool` message with the correct `tool_call_id`, or the request errors. Independent calls tend to be returned in parallel.

## Gaps

- No fetched page mentions Kimi K2.8 Preview or `kimi-for-coding`; any claim about them would be inference.
- P1 is generic prompt advice, not specific to K3.
- P3 uses `kimi-k3`, not K3.1 Pro; its guidance is assumed to apply to K3.1, which the pages do not say.
- P4 was read from search highlights, not a full fetch, and appeared complete to its closing list of the complete flow, which recaps K40 and K42 to K45.
- The pages carry no dates, so none is recorded.
