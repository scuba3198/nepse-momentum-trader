const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const handlers = {};
const deleted = [];
const navigated = [];
let unregistered = false;
const context = {
  caches: {
    keys: async () => ['workbox-precache-v2-nepse-momentum-trader', 'nepse-holidays', 'another-project'],
    delete: async key => deleted.push(key)
  },
  self: {
    addEventListener: (name, handler) => { handlers[name] = handler; },
    skipWaiting: () => true,
    registration: { unregister: async () => { unregistered = true; } },
    clients: { matchAll: async () => [{ url: '/nepse-momentum-trader/', navigate: async url => navigated.push(url) }] }
  }
};

vm.runInNewContext(fs.readFileSync('sw.js', 'utf8'), context);
assert.equal(handlers.install(), true);
let activation;
handlers.activate({ waitUntil: promise => { activation = promise; } });
activation.then(() => {
  assert.deepEqual(deleted, ['workbox-precache-v2-nepse-momentum-trader', 'nepse-holidays']);
  assert.equal(unregistered, true);
  assert.deepEqual(navigated, ['/nepse-momentum-trader/']);
  console.log('Service worker retirement check passed.');
});
