# Web Estate Context Design

## Scope

Implement P0-A in `apps/web` without broadening server-side estate support.
The web application must discover the signed-in user's authorized estates,
choose one valid estate, attach its opaque ID to API requests, and prevent data
from a previous estate from remaining visible after a switch.

## Considered approaches

### 1. Central provider and centralized request scope

Add an `EstateProvider` beneath `AuthProvider`, keep the active opaque estate ID
in one request module, and remount estate-dependent descendants when selection
changes.

This is the selected approach. It gives all API clients the same enforced
header behavior, keeps persistence and selection validation in one component,
and creates a clear boundary for clearing page and provider state.

### 2. Pass the estate ID to every API method

This makes dependencies explicit but spreads security-sensitive header logic
through every client and caller. It also makes omission easy and would require
large, repetitive changes.

### 3. Put the estate ID in every route

URL-scoped estate selection supports deep links but is unnecessary for P0-A and
would expand the routing and migration surface. It also would not remove the
need for centralized API header enforcement.

## Contracts and API client

Add strict Zod schemas for:

- An authorized estate: opaque ID, display name, tenant ID, environment, and
  default marker.
- The `/api/estates` response: server default ID and a bounded, unique list of
  authorized estates.
- Error responses used to classify 401, 403, and service failures.

The estate client uses `apiFetch`, so `/api/estates` receives the normal bearer
token when authentication is enabled. Invalid successful responses fail closed
as unavailable rather than creating a guessed estate.

`apiFetch` owns the active estate ID. It merges `Request` and `RequestInit`
headers, preserves explicit authorization, obtains a bearer token only when
needed, and overwrites the estate header with the provider-selected ID. Changing
the active estate aborts requests created for the prior estate.

## Provider state and selection

`EstateProvider` is mounted between `AuthProvider` and `DemoStateProvider`.
During initialization it clears any prior request scope, loads `/api/estates`,
and selects in this order:

1. A stored ID that exactly matches an authorized estate.
2. The server-provided default ID when it exactly matches an authorized estate.
3. The first authorized estate.

Invalid stored values are removed. Persistence contains only the opaque estate
ID. No tenant metadata, tokens, credentials, or response payloads are stored.

The provider exposes authorized estates, the selected estate, a selection
function, and retry behavior. A switch validates exact membership, updates the
central request scope, persists the new ID, and immediately remounts
estate-dependent descendants under a key derived from the opaque ID.

## Data isolation

The keyed estate boundary clears React state for demo data, governance,
exposure, economics, business value, work queue, and other routed views before
the new estate loads. Central request cancellation aborts prior in-flight
requests; component cleanup remains a second guard when a test double or client
does not honor abort signals.

The runtime drift cache includes the active estate ID in its cache key so a
fulfilled entry can never be reused across estates. Existing server middleware
continues to reject non-default estate access to routes that are not yet
estate-aware.

## User experience and failures

The application renders explicit states before mounting estate-dependent data:

- Loading authorized estates.
- No authorized estates.
- Authentication required (401).
- Estate access denied (403).
- Estate service unavailable, including network, 5xx, and contract failures.

An accessible labeled selector appears in the top bar only when more than one
estate is authorized. Single-estate deployments retain the current shell
without an unnecessary selector. Scope details use the selected estate's
server-provided name, tenant ID, and environment.

## Tests

Unit and component coverage will verify:

- Estate and authorization header injection while preserving caller headers.
- Stored selection, valid server-default selection, and deterministic fallback.
- Invalid stored ID removal.
- Switching estates updates persistence and clears old demo state immediately.
- Prior estate responses are aborted or ignored.
- Empty, 401, 403, and unavailable states.
- The selector is hidden for one estate and shown for multiple estates.
- Drift cache entries are isolated by estate.

Existing route, page, and E2E coverage remains in place. Final validation uses
the required web and repository commands without accessing cloud resources.
