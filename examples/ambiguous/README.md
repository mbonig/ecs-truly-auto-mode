# Fixture: ambiguous

Exercises **escalation**. Three things the analysis must ask about rather than
guess:

1. Two `EXPOSE` ports (8080, 9090) — which one takes load balancer traffic?
2. `EXPOSE 8080` conflicts with `server.listen(4000)` — recorded as `conflict`
   with both values and their evidence, never resolved by preferring the
   Dockerfile.
3. No health endpoint exists — must offer a TCP check or ask for a path.

A run that silently picks 8080 and invents `/health` has failed this fixture.
