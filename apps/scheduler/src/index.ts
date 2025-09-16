import ical from 'ical';
import fetch from 'node-fetch';

async function fetchIcs(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('failed_ics');
  const text = await res.text();
  return ical.parseICS(text);
}

async function enqueueConvertExisting(apiBase: string, payload: any) {
  const res = await fetch(`${apiBase}/v1/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`enqueue_failed ${res.status}`);
  return res.json();
}

async function runOnce() {
  if (!process.env.API_BASE) {
    console.log('scheduler dry-run: set API_BASE to enqueue');
    return;
  }
  // Example placeholder payload
  const payload = {
    command_type: 'convert_existing',
    clinic_id: 'clinic_1',
    practitioner_key: 'pract_1',
    idempotency_key: `demo-${Date.now()}`
  };
  const r = await enqueueConvertExisting(process.env.API_BASE, payload);
  console.log('enqueued', r);
}

runOnce().catch(err => {
  console.error('scheduler error', err);
});

console.log('scheduler stub');
