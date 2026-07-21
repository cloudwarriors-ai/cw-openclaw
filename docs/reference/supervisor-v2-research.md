---
title: "Supervisor v2 — Runtime Supervision Patterns for Production LLM Agents (Research)"
summary: "Sourced research on ingress/egress guardrails, re-grounding loops, multi-agent supervision, and cost/latency tradeoffs, grounded for ScopelyBot's v2 supervisor requirement."
status: research
---

# Supervisor v2 — Runtime Supervision Patterns for Production LLM Agents

> Research doc, not a spec. Fetched 2026-07-20. Every load-bearing claim below is tagged
> `(curl)` (fetched the primary source and read the supporting text), `[snippet]` (search
> result text only, not fetched in full), or `[UNVERIFIED]` (could not ground — flagged, not
> asserted as fact). See "Unverified / weak" at the bottom.

## Executive summary — what a well-grounded v2 should include and exclude

The product owner's v2 requirement — "intakes everything incoming and outgoing, validates it
for security / for accuracy / pushes back and forces a re-grounding if it's not correct" —
maps cleanly onto architecture that every source below converges on independently: **separate,
narrow, deterministic-first checks at the ingress and egress boundary, with model-based
checks reserved for what deterministic checks structurally cannot do, and a bounded
correction loop with a hard circuit breaker.** None of the sources argue for a single
do-everything LLM-judge supervisor; several argue explicitly against it.

**Include, with grounding:**

- **Ingress: layer deterministic heuristics first, a small classifier model second.** OWASP's
  own top mitigation for prompt injection is constraining model behavior and _deterministic_
  output-format validation, not primarily model-based detection (curl, OWASP LLM01). NVIDIA's
  own jailbreak-heuristics latency numbers show a non-LLM heuristic (perplexity via GPT-2) still
  costs 115ms (GPU) to 3.2s (CPU, in-process) per check (curl, NeMo docs) — "deterministic" does
  not mean "free," but it is far cheaper than a full LLM call. Purpose-built small classifiers
  (Llama Prompt Guard 2 at 86M params) exist specifically because a full LLM classifier is
  latency-disproportionate for this check (curl, Hugging Face model card).
- **Egress: prefer deterministic claim-vs-evidence matching / NLI-style entailment over LLM
  self-judgment, and treat "the fact-check LLM is itself unreliable" as a documented failure
  mode, not a hypothetical.** NeMo Guardrails explicitly recommends falling back to a
  purpose-built deterministic model (AlignScore, a RoBERTa NLI-style scorer) or a dedicated
  hallucination-detection model (Patronus Lynx) _when the primary LLM does not reliably follow
  the self-check prompt_ (curl, NeMo fact-checking catalog). This is the closest published
  analog to your existing v1 "zero-tool-activity" state-claim check — evidence-existence is a
  fact you can check deterministically without asking a model to judge itself.
- **Re-grounding: bound every retry loop, and don't trust intrinsic (no-external-feedback)
  self-correction to reliably improve outputs.** Anthropic's own "evaluator-optimizer" pattern
  and "stopping conditions (such as a maximum number of iterations)" guidance (curl,
  Anthropic engineering blog) validates the fuse your v1 already has. The academic finding that
  should worry you: LLMs "struggle to self-correct their responses without external feedback,
  and at times, their performance even degrades after self-correction" (curl, Huang et al.,
  ICLR 2024). CRITIC and Chain-of-Verification's actual improvements come from grounding the
  revision in **external, independently-fetched evidence** (a search engine, a code
  interpreter, independently-answered verification questions) — not from asking the same model
  to re-read its own answer and try harder (curl, CRITIC / CoVe abstracts).
- **Separate the supervisor from the primary call.** Anthropic explicitly recommends this
  exact architecture — "one model instance processes user queries while another screens them
  ... this tends to perform better than having the same LLM call handle both guardrails and the
  core response" (curl, Anthropic engineering blog) — which argues against folding checks into
  the coordinator's own reasoning, and for the separate-process supervisor your v1 already is.
- **Multi-agent supervision (spoke output before coordinator consumption) is a known and
  costed pattern**, not a novel idea: CrewAI's hierarchical process names a manager agent that
  explicitly "validates outcomes" before results are treated as final (curl, CrewAI docs);
  LangChain's own current multi-agent docs quantify that your architecture's closest analog
  (their "Subagents" pattern — worker output routes back through a coordinator) costs one
  extra model call per turn versus patterns that let workers answer the user directly (curl,
  LangChain multi-agent docs) — a real, sized cost, not a hand-wave.

**Exclude, on the evidence:**

- **A single LLM-judge lane that is trusted uncritically for both security and accuracy.**
  LLM-as-judge has real, measured, and named biases — position bias, verbosity bias, and
  **self-enhancement bias** (a judge favoring outputs similar to its own style) — that the
  primary paper on the technique documents itself while still reporting it as useful (curl,
  Zheng et al., MT-Bench/Chatbot Arena, NeurIPS 2023). G-Eval separately documents the same
  self-preference risk toward LLM-generated text (curl, Liu et al., G-Eval abstract). Any
  LLM-judge lane you add should be a narrow, bounded check with a deterministic fallback, not
  the supervisor's backbone.
- **Unbounded revision loops.** The one academic study specifically testing whether forced
  self-revision helps found it can make reasoning _worse_, not better, absent external
  evidence (curl, Huang et al. above). Anthropic's own guidance pairs every evaluator-optimizer
  loop with an explicit stopping condition. Your v1 fuse (3 revisions / 10 min → accept +
  escalate) is the right shape; v2 should keep and reuse it rather than replace it with an
  unbounded "keep re-grounding until correct" loop, which no cited source recommends and one
  actively warns against.
- **Blanket detection-tool adoption without a maintenance check.** Rebuff — one of the
  most-cited open-source prompt-injection detectors, offered as a specific research question —
  is **archived by its owner as of May 16, 2025 and is now read-only** (curl, GitHub repo). This
  is a concrete, grounded instance of "strongest practitioners don't necessarily maintain
  dedicated PI-detector projects long-term"; treat any specific open-source detector as a
  build-vs-buy decision with a freshness check, not a durable dependency.
- **A model-based check on every turn without a latency budget check.** NVIDIA's own published
  numbers show a _heuristic_ (not even an LLM) safety check costs multiple seconds on CPU
  in-process (curl, NeMo docs, quoted below). For a chat-ops bot on a seconds-scale reply
  budget, an LLM-based classifier lane on every turn needs an explicit latency budget decision,
  not an assumption that "small model = fast."

---

## Q1 — Input/ingress guardrails

### What OWASP recommends (LLM01:2025 Prompt Injection)

`(curl)` Fetched `https://genai.owasp.org/llmrisk/llm01-prompt-injection/` (OWASP GenAI
Security Project, 2025 edition). OWASP's own ordered mitigation list for prompt injection is:

1. **Constrain model behavior** — system-prompt role/capability limits, "instruct the model to
   ignore attempts to modify core instructions."
2. **Define and validate expected output formats** — "use deterministic code to validate
   adherence to these formats."
3. **Implement input and output filtering** — "Apply semantic filters and use string-checking
   to scan for non-allowed content. Evaluate responses using the RAG Triad: Assess context
   relevance, groundedness, and question/answer relevance."
4. **Enforce privilege control and least privilege access** — "handle these functions in code
   rather than providing them to the model."
5. **Require human approval for high-risk actions** — explicit human-in-the-loop for
   privileged operations (this is precisely your existing confirm-gate).
6. **Segregate and identify external content.**
7. Adversarial testing.

The notable fact: OWASP's own list is _deterministic-code-first_ — items 1, 2, 4, and 5 are
code/config controls, not model classifiers. Item 3 is the only explicitly model-adjacent
mitigation, and even it pairs semantic filtering with string-checking rather than replacing it.

`(curl)` OWASP's LLM Top 10 2025 full list (fetched `genai.owasp.org/llm-top-10/`), for
completeness and to show where the other candidate ScopelyBot v1 checks map: LLM01 Prompt
Injection, LLM02 Sensitive Information Disclosure, LLM03 Supply Chain, LLM04 Data and Model
Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, LLM07 System Prompt
Leakage, LLM08 Vector and Embedding Weaknesses, LLM09 Misinformation, LLM10 Unbounded
Consumption. Your v1's confirm-code-leak and secret-shape checks map to LLM02/LLM07; raw-JSON-dump
maps to LLM05; state-claims-with-zero-tool-activity maps to LLM09.

### Deterministic heuristics vs model classifiers — concrete published tradeoffs

`(curl)` NVIDIA NeMo Guardrails' jailbreak-detection heuristics catalog page (fetched
`docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/jailbreak-protection.md`)
publishes exact false-positive numbers for its two purely-heuristic (no LLM) detectors:

- **Length-per-perplexity** (input length ÷ perplexity via `gpt2-large`): at the published
  default threshold (89.79, the mean value observed across a labeled jailbreak/non-jailbreak
  dataset built from AdvBench, ToxicChat, JailbreakChat, and Dolly-15k), the doc states this
  "yields 31.19% of jailbreaks being detected with a false positive rate of 7.44% on the
  dataset." The doc explicitly notes the threshold is a detection/false-positive tradeoff knob:
  "Increasing this threshold will decrease the number of jailbreaks detected but will yield
  fewer false positives."
- **Prefix/suffix perplexity** (targets GCG-style adversarial-suffix attacks specifically): "the
  default value allows for detection of 49/50 GCG-style attacks with a 0.04% false positive
  rate."
- Both heuristics are explicitly scoped: "intended only for English language evaluation and
  will yield significantly more false positives on non-English text, including code" — a
  directly relevant caveat for a chat-ops bot that will see code/JSON/config strings in normal
  operator traffic.

**Latency** (same doc, same fetch), measured across 10 prompts (5–2048 tokens), averaged, in
milliseconds:

|            | CPU  | GPU |
| ---------- | ---- | --- |
| Docker     | 2057 | 115 |
| In-process | 3227 | 157 |

This is a pure heuristic, not an LLM call, and it still costs multiple seconds on CPU. This is
the single most load-bearing latency data point for Q5 below.

`(curl)` Model-based classifiers exist as a _purpose-built, small-model_ alternative for exactly
this latency reason. Meta's **Llama Prompt Guard 2** model card (fetched
`huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M`) confirms it is an **86M-parameter**
`deberta-v2`-based text-classification model — small enough to run as a low-latency ingress
classifier, distinct from asking a full chat model to classify. **Llama Guard 3 8B** (fetched
`huggingface.co/meta-llama/Llama-Guard-3-8B`) is the larger, broader-taxonomy sibling: its
published chat template shows a **14-category safety taxonomy** (S1 Violent Crimes through S14
Code Interpreter Abuse) applied to either the user or assistant turn, returning `safe`/`unsafe`
plus violated categories — i.e., designed as a dedicated input-_and_-output classifier, not a
general chat model repurposed for the job.

`(curl)` **Anthropic's constitutional classifiers** (fetched
`anthropic.com/news/constitutional-classifiers`, Feb 3, 2025) are the most rigorously
red-teamed published input+output classifier pair for jailbreak defense specifically: "input
and output classifiers trained on synthetically generated data that filter the overwhelming
majority of jailbreaks with minimal over-refusals and without incurring a large compute
overhead." Concrete published numbers: a prototype version was "robust to thousands of hours
of human red teaming for universal jailbreaks, albeit with **high overrefusal rates and
compute overhead**"; an updated, shipped version "achieved similar robustness on synthetic
evaluations, and did so with a **0.38% increase in refusal rates and moderate additional
compute costs**." This is a directly-quotable false-positive/cost tradeoff from the team that
also builds Claude.

`(curl)` **Guardrails AI** (fetched `guardrailsai.com/docs` and the `guardrails-ai/guardrails`
GitHub README) is the clearest example of the _deterministic-validator_ end of the spectrum:
"Guardrails runs Input/Output Guards ... that detect, quantify and mitigate the presence of
specific types of risks," composed from a "Hub" of pre-built **validators** — the README's own
example is a plain regex phone-number matcher (`RegexMatch`) composed with a toxicity/competitor
classifier in the same `Guard`. The framework explicitly mixes deterministic (regex,
string-match) and model-based (toxicity classifier) validators in one pipeline rather than
picking one approach — directly supporting a layered design.

`(curl)` **Rebuff** (fetched `github.com/protectai/rebuff`) documents a 4-layer defense
(heuristics → dedicated LLM detector → vector-DB similarity to known past attacks → canary
tokens to detect prompt leakage) and is useful as a _pattern reference_ — but the repository
banner states plainly: **"This repository was archived by the owner on May 16, 2025. It is now
read-only."** Ground truth for the "what strongest practitioners don't do" question: don't
assume a well-cited open-source PI detector is a live dependency without checking.

`(curl)` NeMo's guardrail catalog (fetched `guardrail-catalog.md`) also confirms **third-party
PII detectors** are treated as a distinct category from jailbreak/content-safety: its own
GLiNER-PII integration is NER-model-based (fetched `pii-detection.md`, "NVIDIA GLiNER-PII NIM");
the catalog's third-party list `[snippet from the same curl-fetched nav]` also names Presidio
(Microsoft's regex+NER hybrid) and Private AI as PII-specific integrations — i.e., PII screening
is its own guardrail category with its own deterministic-vs-model options, not lumped into
general jailbreak/content-safety classifiers.

---

## Q2 — Output/egress guardrails: grounding & factuality

### Deterministic claim-vs-evidence, NLI, and LLM-self-check — as implemented, not theorized

`(curl)` NeMo Guardrails' fact-checking catalog page (fetched
`guardrail-catalog/fact-checking.md`) documents three distinct implementations side by side,
which is the clearest primary-source evidence for "when deterministic beats LLM judge":

1. **Self-check fact-checking** — an LLM is prompted with an NLI-shaped template: `"evidence":
{{ evidence }} "hypothesis": {{ response }} "entails":` and must answer yes/no; the action
   "returns a score between 0.0 ... and 1.0." The doc's own caveat: **"The performance of this
   rail is strongly dependent on the capability of the LLM to follow the instructions ... If
   your LLM does not reliably follow this prompt, consider a model purpose-built for
   hallucination detection instead."** It also documents a concrete failure mode: reasoning
   models can exhaust `max_tokens` on internal reasoning before emitting a verdict, and the
   rail is coded to **fail-closed** in that case (returns `0.0`, response blocked) — a
   deterministic safety net around a probabilistic check.
2. **AlignScore-based fact-checking** — a dedicated **RoBERTa-based** model (Zha et al., cited
   as `aclanthology.org/2023.acl-long.634.pdf` in the fetched doc) "for scoring factual
   consistency in model responses with respect to the knowledge base." This is the deterministic
   NLI-model alternative offered explicitly _because_ the LLM self-check is unreliable.
3. **Patronus Lynx-based hallucination detection** — a dedicated hallucination-detection model
   (70B and 8B variants, hosted on Hugging Face per the fetched doc) as a third option.

For the no-knowledge-base case, NeMo's **hallucination detection** rail (same fetch) implements
a variant of **SelfCheckGPT**: "sample several extra responses from the LLM ... use the LLM to
check if the original and extra responses are consistent," formulated "similar to an NLI task."
`(curl)` SelfCheckGPT's own abstract (fetched `arxiv.org/abs/2303.08896`, Manakul et al.)
confirms the core idea and its motivation: a **zero-resource, sampling-based** check for
black-box models "without an external database" — "if an LLM has knowledge of a given concept,
sampled responses are likely to be similar and contain consistent facts. However, for
hallucinated facts, stochastically sampled responses are likely to diverge." This is a distinct
mechanism from evidence-grounded fact-checking: it detects _inconsistency_, not _falsity against
a source_, which matters for ScopelyBot — sampling-consistency checking says nothing about
whether a confidently-consistent claim is actually true against your tool evidence; it only
catches claims the model itself is unsure about.

**Application to your v1's zero-tool-activity check:** your existing deterministic
state-claims-with-zero-tool-activity regex is closer in spirit to AlignScore/deterministic
matching than to LLM self-check — it doesn't ask a model to judge groundedness, it structurally
detects the _absence_ of the evidence a grounded claim would require. The NeMo docs' own
guidance ("if your LLM does not reliably follow this prompt, consider a purpose-built model")
is direct support for keeping that check deterministic rather than replacing it with an LLM
self-check pass.

### LLM-as-judge reliability — bias, calibration, when it's still useful

`(curl)` Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" (fetched
`arxiv.org/abs/2306.05685`, NeurIPS 2023 Datasets and Benchmarks Track — the paper that
established the technique). The abstract itself names the failure modes: **"position,
verbosity, and self-enhancement biases, as well as limited reasoning ability"** — and proposes
mitigations for some. It also reports the positive case: "strong LLM judges like GPT-4 can
match both controlled and crowdsourced human preferences well, achieving **over 80%
agreement**, the same level of agreement between humans." So the technique is validated by its
own authors as useful _and_ documented by the same authors as biased — both facts are
load-bearing, not in tension.

`(curl)` Liu et al., "G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment" (fetched
`arxiv.org/abs/2303.16634`). Reports Spearman correlation of **0.514** with human judgment on
summarization (an improvement over prior LLM-based evaluators) but explicitly flags: **"the
potential issue of LLM-based evaluators having a bias towards the LLM-generated texts"** —
i.e., a judge favoring outputs stylistically similar to its own generation distribution. For
ScopelyBot specifically, this self-enhancement risk is sharpest if the supervisor model and the
coordinator model are the same model family — an argument for either a different model/vendor
for the judge lane, or for keeping the judge lane narrow and deterministic-backed rather than
holistic.

**Application:** deterministic claim-vs-evidence matching should be the default egress check
(cheap, no self-preference bias, fails closed on ambiguity per NeMo's own implementation
pattern). An LLM-judge lane, if added, should be scoped to what deterministic checks cannot do
(e.g., "does this reply's tone/register match the persona," not "is this fact true") and should
not be the sole gate on factual claims.

---

## Q3 — Re-grounding / self-correction loops

### Published self-correction patterns

`(curl)` **Reflexion** (Shinn et al., fetched `arxiv.org/abs/2303.11366`): agents "verbally
reflect on task feedback signals, then maintain their own reflective text in an episodic memory
buffer" — reinforcement via language, not weight updates. Reports 91% pass@1 on HumanEval vs.
an 80% GPT-4 baseline. Key structural point: Reflexion's feedback signal can be **external or
internally simulated** — the paper does not claim pure self-reflection alone drives the gain;
task feedback (e.g., unit test pass/fail in the coding case) is the grounding signal.

`(curl)` **Self-Refine** (Madaan et al., fetched `arxiv.org/abs/2303.17651`): the same LLM acts
as generator, critic, and refiner in an iterative loop, "does not require any supervised
training data, additional training, or reinforcement learning." Reports ~20% absolute average
improvement across 7 tasks. This is the purest "ask the model to re-check its own work" pattern
of the four — and it is also the pattern the Huang et al. paper below specifically tested and
found unreliable for _reasoning_ tasks without external feedback (the two papers are not
directly contradictory — Self-Refine's gains are strongest on tasks with a natural
human-preference-style feedback signal like dialog/creative generation, not pure logical
correctness).

`(curl)` **CRITIC** (Gou et al., fetched `arxiv.org/abs/2305.11738`, ICLR 2024): explicitly
tool-augmented — "CRITIC interacts with appropriate tools to evaluate certain aspects of the
text, and then revises the output based on the feedback obtained during this validation
process," analogous to "using a search engine for fact-checking, or a code interpreter for
debugging." The abstract's framing directly names the mechanism your egress plane already has
(same-turn tool evidence) as the credible source of revision signal, as opposed to pure
self-critique.

`(curl)` **Chain-of-Verification / CoVe** (Dhuliawala et al., fetched
`arxiv.org/abs/2309.11495`): draft → **plan verification questions** → **answer them
independently** (explicitly "so the answers are not biased by other responses") → produce final
verified response. "CoVe decreases hallucinations across a variety of tasks." The
independent-answering step is the structural insight most transferable to a v2 re-grounding
design: don't let the re-grounding check see (and anchor on) the original draft while verifying
it.

### Does forced revision help or hurt — the direct evidence

`(curl)` Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet" (fetched
`arxiv.org/abs/2310.01798`, ICLR 2024). This is the most directly relevant paper to "does forced
revision actually improve factuality." Its own definition of the failure mode: **"intrinsic
self-correction, whereby an LLM attempts to correct its initial responses based solely on its
inherent capabilities, without the crutch of external feedback."** Finding: **"LLMs struggle to
self-correct their responses without external feedback, and at times, their performance even
degrades after self-correction."** This is a direct, named caution against a re-grounding loop
that just asks the coordinator to "try again" without new evidence — the loop needs to inject
something the model didn't already have (fresh tool output, an independent verification
question, a different model) or it risks making the answer worse, not better.

### Circuit-breaker / fuse patterns for bounded retry

`(curl)` Anthropic's own engineering guidance (fetched
`anthropic.com/engineering/building-effective-agents`, published Dec 19, 2024) describes the
"evaluator-optimizer" workflow as a named, recommended pattern: **"one LLM call generates a
response while another provides evaluation and feedback in a loop."** Directly adjacent
guidance on bounding it: for autonomous agents generally, **"it's also common to include
stopping conditions (such as a maximum number of iterations) to maintain control."** This is
the same shape as your v1 fuse (3 revisions / 10 min → accept + escalate) — Anthropic's own
production guidance for agent builders names exactly this control, not as an afterthought but
as a first-class part of the pattern.

The term "circuit breaker" itself is a general software-reliability pattern (Michael Nygard,
_Release It!_, 2007) predating LLM agents; I did not find an LLM-agent-specific paper that
names "circuit breaker" as a term of art for retry loops — the Anthropic "stopping conditions"
guidance above is the closest primary-source LLM-agent-specific equivalent I could ground.
`[UNVERIFIED]` — treat "circuit breaker" as your own team's naming convention for a pattern
that is well-attested (stopping conditions / bounded iteration), not as an externally
standardized LLM-agent term.

---

## Q4 — Multi-agent supervision (reviewing worker output before the orchestrator consumes it)

`(curl)` **CrewAI's hierarchical process** (fetched `docs.crewai.com/en/learn/hierarchical-process.md`):
names this pattern explicitly. "A 'manager' agent coordinates the workflow, delegates tasks,
and **validates outcomes** for streamlined and effective execution." Documented key features
include "**Result Validation**: The manager evaluates outcomes to ensure they meet the required
standards" as a first-class, named feature — i.e., a verifier-before-consumption step is a
built-in, documented mode of a major multi-agent framework, not a novel design.

`(curl)` **LangChain's current multi-agent pattern docs** (fetched
`docs.langchain.com/oss/python/langchain/multi-agent.md`, 2026) — the closest published taxonomy
to ScopelyBot's hub-and-spoke shape is their **"Subagents"** pattern: "A main agent coordinates
subagents as tools. All routing passes through the main agent, which decides when and how to
invoke each subagent." The doc's own performance table quantifies the cost of exactly the
"results flow back through the main agent" step your architecture already has: for a one-shot
request, Subagents costs **4 model calls** vs. **3** for patterns (Handoffs, Skills, Router)
that let a worker answer the user directly — "Subagents adds one extra call because results
flow back through the main agent — this overhead provides centralized control." For a
multi-domain request touching several workers in parallel, Subagents costs **5 calls / ~9K
tokens**, comparable to Router and cheaper than sequential Handoffs (7+ calls / ~14K+ tokens).
This is a directly-costed confirmation that coordinator-mediated review (your architecture, and
by extension a supervisor pass on it) has a known, bounded, quantified overhead — not an
unbounded one.

`(curl)` **AutoGen** (Wu et al., fetched `arxiv.org/abs/2308.08155`): "an open-source framework
that allows developers to build LLM applications via multiple agents that can converse with
each other" with "customizable, conversable" agents supporting "combinations of LLMs, human
inputs, and tools." The abstract itself does not name a specific verifier-agent pattern or
publish cost/latency numbers for one — `[snippet]`-strength only for the review-pattern
question; the paper is better grounding for "multi-agent conversation framework exists and is
published" than for "here is AutoGen's specific supervision-cost data."

`(curl)` Anthropic's **"orchestrator-workers"** workflow (same fetch as Q3): "a central LLM
dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results" —
structurally identical to ScopelyBot's coordinator + spokes shape, published as a named,
recommended pattern by the vendor whose models you're running.

**Cost/latency evidence for this question specifically:** LangChain's quantified table above is
the only source in this research pass with real per-call numbers for a review/consumption step
in a multi-agent pipeline; treat CrewAI's and AutoGen's supervision descriptions as pattern
confirmation, not cost confirmation.

---

## Q5 — Cost/latency reality for guardrail layers

This is the thinnest-published area of the six questions — most guardrail vendors publish
_capability_ claims, not systematic latency benchmarks, and one source I attempted to fetch
(Guardrails AI's own comparative "Guardrails Index" benchmark site, `index.guardrailsai.com`)
render its content client-side via JavaScript; `curl` returned only the page shell with no
benchmark numbers reachable. **`[UNVERIFIED]`** — I could not confirm any of Guardrails AI's own
published latency comparisons; the GitHub README (curl-verified) only confirms the benchmark's
_existence_ ("[Feb 12, 2025] We just launched Guardrails Index — the first of its kind
benchmark comparing the performance and latency of 24 guardrails across 6 most common
categories") without giving numbers in the fetched content.

What I could ground with real numbers:

- **NeMo jailbreak heuristics** (curl, quoted fully in Q1): 115ms (GPU, Docker) to 3227ms (CPU,
  in-process) per check, for a check that is _not even an LLM call_ — pure perplexity
  computation via `gpt2-large`. This is the single hardest number available for "what does a
  non-trivial guardrail check cost," and it argues that GPU availability, not
  deterministic-vs-model-based, may be the dominant latency variable for perplexity-style
  checks.
- **Model size as a latency proxy**: Llama Prompt Guard 2 at 86M parameters (curl, HF model
  card) vs. Llama Guard 3 at 8B parameters (curl, HF model card) — roughly two orders of
  magnitude difference in parameter count for narrower (injection-only) vs. broader
  (14-category safety) classification. No published inference-latency benchmark was fetched for
  either; parameter count is a proxy, not a measured latency number. `[UNVERIFIED]` for actual
  ms-latency of either model — I could not find and fetch a benchmark page with real numbers in
  this pass.
- **Anthropic constitutional classifiers**: "moderate additional compute costs" (curl, quoted
  in Q1) — qualitative, not a number. `[UNVERIFIED]` for a specific ms or $ figure.
  Anthropic's post does _not_ publish a latency number, only "moderate."
- **Multi-agent call-count overhead** (curl, LangChain, quoted in Q4): +1 model call for
  Subagents-pattern review vs. direct-answer patterns, per turn. This is the most concrete,
  directly-transferable overhead number for "what does adding a review/consumption hop cost" in
  a hub-and-spoke shape like ScopelyBot's — translate model-calls to wall-clock using your own
  measured per-call latency for the coordinator model, since no source publishes that for your
  specific stack.

**Application to sizing a model-based lane for a seconds-scale reply budget:** the grounded
data supports (a) a small, purpose-built classifier (Prompt Guard 2-scale, tens of millions of
params) is architecturally intended for exactly this low-latency-ingress role, and (b) even a
"free" heuristic check is not actually free — budget for it explicitly rather than assuming
"non-LLM = instant." No source in this pass gives a defensible ms number for "a full LLM-judge
call added to every turn"; that number needs to come from your own measurement against your
actual coordinator/spoke model, not from a vendor claim.

---

## Q6 — What the strongest practitioners don't do (over-supervision failure modes)

- **False positives blocking legitimate traffic is a published, quantified tradeoff, not a
  hypothetical.** NeMo's own jailbreak heuristics carry a 7.44% false-positive rate at their
  documented default threshold (curl, quoted in Q1) — and the doc's own usage note says
  "manual inspection of false positives uncovered a number of mislabeled examples in the
  dataset **and a substantial number of system-like prompts**" — i.e., prompts that look
  structurally like jailbreaks (system-prompt-shaped, high perplexity) but are legitimate
  operational traffic get caught. For a chat-ops bot whose normal traffic includes
  system-like/structured operator commands, this is a directly relevant caution, not an edge
  case.
- **Anthropic's own constitutional classifiers shipped with a measured overrefusal cost, and the
  team explicitly reports it rather than hiding it**: prototype had "high overrefusal rates,"
  the production version still carries "a 0.38% increase in refusal rates" (curl, quoted in
  Q1) — presented by the authors themselves as the real cost of the security gain, not zero-cost.
- **Forced self-correction without new evidence can make answers worse, per the one paper that
  specifically tested it** (curl, Huang et al., quoted in Q3) — the strongest available
  grounded evidence against an "always force one more revision pass" policy.
- **A widely-cited, well-designed open-source prompt-injection detector (Rebuff) is no longer
  maintained** (curl, quoted in Q1) — evidence that "adopt a dedicated third-party detector"
  carries an ongoing-maintenance risk the strongest teams (Anthropic, NVIDIA, Meta) instead
  address by shipping the detector as part of a maintained platform (constitutional classifiers,
  NeMo Guardrails, Llama Guard/Prompt Guard) rather than a standalone community tool.
- **LLM-as-judge's own inventing papers name its biases up front** rather than presenting it as
  a solved problem (curl, Zheng et al. and Liu et al., both quoted in Q2) — position bias,
  verbosity bias, self-enhancement bias are the field's own stated caveats on the technique your
  product owner's "pushes back... forces a re-grounding" requirement most naturally maps to if
  implemented as a pure LLM-judge lane. This is the strongest piece of evidence in this whole
  research pass against building v2's core loop _only_ as an LLM judge.

---

## Recommendations table

Mapping grounded findings to the four candidate planes named in the task, plus the optional
LLM-judge lane. "Evidence" column cites the section above; every cell traces to a `(curl)`
finding unless marked otherwise.

| Plane                                                         | What the evidence supports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Grounded in |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Inbound validation**                                        | Deterministic checks first (format/schema, confirm-code shape, secret-shape regex — your v1 already does this); layer a small purpose-built classifier (Prompt-Guard-2 scale) only if false-positive rate on your own operator-traffic corpus is measured and acceptable — NeMo's own heuristic carries a documented false-positive rate on system-like prompts, which describes your operator traffic. Budget latency explicitly; even non-LLM checks cost real ms.                                                                                                                                                             | Q1, Q5, Q6  |
| **Spoke-output review before coordinator consumption**        | A known, named pattern (CrewAI manager validation, Anthropic orchestrator-workers, LangChain Subagents) with a quantified cost (+1 model call/turn vs. direct-answer patterns). Keep it — it's architecturally validated — but treat the extra call as a real, sized cost to your reply-latency budget, not free.                                                                                                                                                                                                                                                                                                                | Q4, Q5      |
| **Deterministic claim-grounding vs. same-turn tool evidence** | This is the highest-confidence recommendation in the whole doc. NeMo's own fact-checking implementation explicitly recommends falling back to a deterministic/purpose-built model when the LLM self-check is unreliable; your existing zero-tool-activity check is structurally the same idea. CRITIC and CoVe's actual gains come from external, independently-fetched evidence, not self-critique. Keep this deterministic; do not replace it with an LLM self-check pass.                                                                                                                                                     | Q2, Q3      |
| **Fresh-read data-correctness probe**                         | Not directly covered by a named published pattern in this pass — closest analog is CoVe's "answer verification questions independently, not biased by the original response," which argues for the probe re-deriving the answer from a fresh read rather than checking the original draft's self-consistency. Treat as your own design extending a grounded principle, not a directly cited external pattern. `[UNVERIFIED as a named pattern]` — the principle (independent re-derivation beats self-consistency checking) is grounded; "fresh-read probe" as your specific mechanism is not something I found named elsewhere. | Q3 (CoVe)   |
| **Optional LLM-judge lane**                                   | Include only as a narrow, bounded supplement — not the backbone. Both foundational LLM-as-judge papers name position/verbosity/self-enhancement bias as real, measured problems even while validating the technique's ~80% human-agreement rate. If added, scope it to what deterministic checks structurally cannot do (tone, persona fit) rather than factual correctness, and prefer a different model/vendor than the coordinator to reduce self-enhancement bias risk.                                                                                                                                                      | Q2, Q6      |
| **Re-grounding retry loop (cross-cutting)**                   | Bound it — your v1 fuse (3 revisions/10min → accept + escalate) matches Anthropic's own "stopping conditions" guidance for exactly this pattern. Do not let a revision pass proceed without new evidence (fresh tool call, independent verification question); the one paper testing pure self-correction found it can degrade answers.                                                                                                                                                                                                                                                                                          | Q3          |

---

## Sources

| URL                                                                                                           | Tier                   | Note                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| https://genai.owasp.org/llmrisk/llm01-prompt-injection/                                                       | (curl)                 | OWASP LLM01:2025, full mitigation list                                                              |
| https://genai.owasp.org/llm-top-10/                                                                           | (curl)                 | OWASP LLM Top 10 2025, full 10-item list                                                            |
| https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/                                           | (curl)                 | LLM05:2025, output-handling risk definition                                                         |
| https://genai.owasp.org/llmrisk/llm092025-misinformation/                                                     | (curl)                 | LLM09:2025, mitigation list (RAG, cross-verification, automatic validation)                         |
| https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/jailbreak-protection.md | (curl)                 | Jailbreak heuristics: FP rates, latency table                                                       |
| https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/fact-checking.md        | (curl)                 | Self-check facts, AlignScore, Patronus Lynx, SelfCheckGPT-based hallucination rail                  |
| https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/self-check.md           | (curl)                 | LLM self-check input/output rail design, fail-closed behavior                                       |
| https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog.md                      | (curl)                 | Guardrail catalog taxonomy                                                                          |
| https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/pii-detection.md        | (curl)                 | GLiNER-PII, PII detection approach                                                                  |
| https://docs.nvidia.com/nemo/guardrails/latest/configure-guardrails/guardrail-catalog/agentic-security.md     | (curl)                 | Fetched; agentic security catalog (supporting context)                                              |
| https://docs.nvidia.com/nemo/guardrails/about-nemo-guardrails-library/overview                                | (curl)                 | NeMo doc-site nav confirming rail-type taxonomy                                                     |
| https://docs.nvidia.com/nemo/guardrails/llms.txt                                                              | (curl)                 | Doc-site index used to locate catalog pages                                                         |
| https://huggingface.co/meta-llama/Llama-Guard-3-8B                                                            | (curl)                 | 14-category safety taxonomy, chat template                                                          |
| https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M                                                    | (curl)                 | 86M-param injection/jailbreak classifier                                                            |
| https://www.anthropic.com/news/constitutional-classifiers                                                     | (curl)                 | Overrefusal (0.38%) and compute-cost tradeoffs                                                      |
| https://www.anthropic.com/engineering/building-effective-agents                                               | (curl)                 | Evaluator-optimizer, orchestrator-workers, stopping conditions, "separate guardrail model" guidance |
| https://www.guardrailsai.com/docs                                                                             | (curl)                 | Guardrails AI framework overview (thin content, JS app)                                             |
| https://github.com/guardrails-ai/guardrails                                                                   | (curl)                 | README: Input/Output Guards, validator composition example                                          |
| https://github.com/protectai/rebuff                                                                           | (curl)                 | 4-layer defense description; repo archived May 16, 2025                                             |
| https://docs.crewai.com/en/learn/hierarchical-process.md                                                      | (curl)                 | Manager agent "Result Validation" feature                                                           |
| https://docs.langchain.com/oss/python/langchain/multi-agent.md                                                | (curl)                 | Subagents pattern, quantified model-call/token overhead                                             |
| https://docs.langchain.com/oss/python/langgraph/workflows-agents                                              | (curl)                 | Fetched; general workflow/agent overview (no supervisor-specific content found)                     |
| https://arxiv.org/abs/2303.11366                                                                              | (curl)                 | Reflexion — abstract                                                                                |
| https://arxiv.org/abs/2303.17651                                                                              | (curl)                 | Self-Refine — abstract                                                                              |
| https://arxiv.org/abs/2305.11738                                                                              | (curl)                 | CRITIC — abstract                                                                                   |
| https://arxiv.org/abs/2309.11495                                                                              | (curl)                 | Chain-of-Verification (CoVe) — abstract                                                             |
| https://arxiv.org/abs/2310.01798                                                                              | (curl)                 | Huang et al., "LLMs Cannot Self-Correct Reasoning Yet" — abstract                                   |
| https://arxiv.org/abs/2303.08896                                                                              | (curl)                 | SelfCheckGPT — abstract                                                                             |
| https://arxiv.org/abs/2306.05685                                                                              | (curl)                 | Zheng et al., LLM-as-judge / MT-Bench — abstract                                                    |
| https://arxiv.org/abs/2303.16634                                                                              | (curl)                 | G-Eval — abstract                                                                                   |
| https://arxiv.org/abs/2308.08155                                                                              | (curl)                 | AutoGen — abstract                                                                                  |
| https://index.guardrailsai.com/                                                                               | (curl, but unreadable) | Fetched; benchmark numbers not reachable via curl (client-side rendered JS app)                     |

---

## Unverified / weak

- **Guardrails AI's own comparative latency benchmark** ("Guardrails Index," 24 guardrails
  across 6 categories) — page exists (curl-confirmed via GitHub README announcement) but the
  benchmark site itself renders client-side; no actual latency/accuracy numbers were reachable
  via `curl`. Do not cite specific numbers from this source without a different retrieval
  method (e.g., their published blog post or paper, if one exists, not checked in this pass).
- **Actual inference latency for Llama Guard 3 (8B) or Prompt Guard 2 (86M) in production** —
  parameter counts are grounded; ms-latency numbers are not. Needed before sizing a per-turn
  classifier lane.
- **A specific dollar or millisecond figure for Anthropic's constitutional classifiers' "moderate
  additional compute costs"** — the phrase is verbatim from the source but is qualitative, not
  quantitative.
- **"Circuit breaker" as an LLM-agent-specific term of art** — grounded as a general
  software-reliability pattern (Nygard, not fetched in this pass — predates and is outside the
  LLM literature) and as "stopping conditions" in Anthropic's agent guidance, but I did not find
  an LLM-agent paper using "circuit breaker" as its own vocabulary. Treat your fuse's naming as
  your team's convention, backed by the stopping-conditions principle, not as citing an
  externally standardized term.
- **AutoGen's specific verifier-agent cost/latency data** — the abstract confirms the framework
  supports multi-agent conversation patterns generally; I did not fetch AutoGen's full paper or
  docs for a specific supervisor/verifier cost number, so this is `[snippet]`-strength for the
  review-pattern question specifically (the framework's existence is `(curl)`-verified via the
  abstract; a specific supervision-cost claim is not).
- **Rebuff's actual detection accuracy numbers** — the README documents the _architecture_
  (4-layer defense) but I did not find published accuracy/FP numbers in the fetched content;
  treat Rebuff as a pattern reference only, not a benchmarked one.
