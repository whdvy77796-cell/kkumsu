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
import '../tests/simple-engine.test.mjs';
