---
name: research-methodology
---

# Research Methodology Skill

When conducting research tasks:

## Search Strategy
1. Start broad, then narrow down
2. Use `search.query` for initial exploration (3-5 results)
3. Use `web.fetch` for deep-dive on promising sources
4. Cross-reference multiple sources

## Source Evaluation
- Prefer primary sources (official docs, RFCs, peer-reviewed)
- Check publication date - prefer last 12 months for tech
- Note author credentials and potential bias
- Distinguish facts from opinions

## Synthesis
- Group findings by theme/question
- Cite sources inline with URLs
- Note conflicting information
- Provide confidence level for conclusions

## Output Format
```
## Findings
### [Topic]
- Finding 1 [source]
- Finding 2 [source]

## Confidence
- High: Well-established facts, multiple sources
- Medium: Single authoritative source
- Low: Speculation, single unverified source
```

## Tools Priority
1. `search.query` - broad web search
2. `web.fetch` - specific URL content
3. `sandbox.read` - local code/docs
4. `sandbox.grep` - search codebase