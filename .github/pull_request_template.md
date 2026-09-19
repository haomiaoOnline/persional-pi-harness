## Personal PI Harness capability boundary

Complete this section for any change that adds or expands capability under `packages/personal-pi/**`. For unrelated changes, mark the first item and continue with the normal review.

- [ ] Not applicable: this change does not add or expand Personal PI Harness core capability.
- [ ] Host-swap test answered: **If this were used by a completely different host project, would this capability still be meaningful?** The answer is **yes**.
- [ ] The PPH core change is limited to reusable Worker, Task, Evidence, Verification, or state-management capability. It does not add host-project business logic such as provider-specific business integration, OAuth flows, API-key rotation, SSE conversion, token-usage dashboards, or host-specific provider configuration UI.
- [ ] If this review exposed an existing boundary violation, the violation is tracked as technical debt with a concrete split/migration plan rather than being silently expanded in PPH core. Tracking reference: `N/A` or link/path.
