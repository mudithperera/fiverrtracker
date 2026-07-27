/**
 * Run the gateway on its own.
 *
 * The API needs Google, Stripe and a database before it will boot — none of which
 * the relay depends on. This starts just the gateway so it can be verified in
 * isolation, which is where the untested risk actually lives.
 *
 *   JWT_SECRET=… PROXY_NZ=host:port:user:pass npm run gateway
 */

import { createProxyGateway } from './gateway.js';
import { configuredCountries } from '../worker/proxies.js';

const jwtSecret = process.env.JWT_SECRET;
const port = Number(process.env.PROXY_GATEWAY_PORT || 8443);

if (!jwtSecret) {
  console.error('JWT_SECRET is required — it must match whatever mints the tokens.');
  process.exit(1);
}

const countries = configuredCountries();
if (!countries.length) {
  console.error('No country proxies configured. Set at least one, e.g. PROXY_NZ=host:port:user:pass');
  process.exit(1);
}

createProxyGateway({ jwtSecret }).listen(port, () => {
  console.log(`Gateway listening on :${port}`);
  console.log(`Countries: ${countries.join(', ')}`);
  console.log('Only Fiverr, only ports 80 and 443, only with a valid token.');
});
