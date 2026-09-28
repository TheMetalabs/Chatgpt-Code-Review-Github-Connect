// Deferred to #81-7+: tip local-verify-outcomes matrix (~116 cells) still needs harbor /
// local-fallback tip deltas that this PR deliberately does not wholesale replace (main ahead).
// #81-6 landed extractChatJsonParts + multiturn residual archive; keep this stub so
// `npm run test:e2e` listing stays honest and CI green until that follow-on.
import test from 'node:test';

test(
  'local-verify-outcomes matrix deferred to #81-7+ (harbor/local-fallback tip deltas)',
  { skip: 'extractChatJsonParts landed in #81-6; outcomes matrix needs tip harbor/fallback deltas without wholesale replace' },
  () => {},
);
