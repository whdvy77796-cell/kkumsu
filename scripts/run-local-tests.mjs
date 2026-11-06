// Local sandbox runner: avoids Node glob traversal of disallowed ancestor folders.
// No network or production credentials. CI still uses npm test with node --test.
import '../tests/server.test.mjs';
import '../tests/payment.test.mjs';
import '../tests/quality-v3.test.mjs';
import '../tests/api-v3.test.mjs';
import '../tests/ops-v3.test.mjs';

import '../tests/revision-v4.test.mjs';
import '../tests/integration-v4.test.mjs';

import '../tests/simple-payment.test.mjs';
import '../tests/notebook-payment.test.mjs';
import '../tests/notebook-diff.test.mjs';
import '../tests/notebook-ui.test.mjs';
import '../tests/simple-engine.test.mjs';
import '../tests/consent-v2.test.mjs';
import '../tests/legacy-recovery-ui.test.mjs';

// File-reader tests patch global browser APIs, so run those in a separate process.
import '../tests/deep-analysis.test.mjs';
import '../tests/overhaul-edge.test.mjs';
import '../tests/analysis-ui.test.mjs';

import '../tests/long-request.test.mjs';

import '../tests/staged-budget.test.mjs';
