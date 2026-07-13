const crypto = require('crypto');
const express = require('express');
const { getSupabase, logSync } = require('../lib/supabase');
const { inviteUserForClient } = require('../lib/invites');

const router = express.Router();

// Public endpoint -- GHL calls this straight from a workflow's plain
// "Webhook" action (just a URL pasted in, no custom body). GHL sends the
// whole contact payload flattened as JSON: standard fields at known keys
// (first_name, last_name, email, phone, ...) plus any custom field (like
// "Business Name") flattened in under a key auto-generated from its label.
// Since the exact custom-field key depends on whatever form/agency is
// wired up, this pulls from a list of likely aliases rather than one exact
// key, and logs the raw body either way so a mismatch is easy to spot and
// fix without needing a code change on the GHL side.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const val = obj?.[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

// GHL's real payload puts first_name/last_name/email/phone/custom-fields at
// the TOP level, but also includes an unrelated nested `contact` object
// (just attribution/tracking metadata -- no name/email/phone in it). Check
// the top level first for every field, falling back to `body.contact` only
// if a given field is missing there, rather than picking one source
// wholesale -- confirmed live against a real "Portal Optin" submission.
function extractSignup(body) {
  const sources = [body, body.contact].filter((s) => s && typeof s === 'object');
  const find = (keys) => {
    for (const src of sources) {
      const val = firstDefined(src, keys);
      if (val) return val;
    }
    return null;
  };
  const email = find(['email', 'Email']);
  const firstName = find(['first_name', 'firstName', 'First Name']);
  const lastName = find(['last_name', 'lastName', 'Last Name']);
  const phone = find(['phone', 'Phone']);
  const businessName = find([
    'business_name',
    'businessName',
    'Business Name',
    'company_name',
    'companyName',
    'company',
  ]);
  const contactName = [firstName, lastName].filter(Boolean).join(' ') || find(['full_name', 'name']);
  return { email, phone, businessName, contactName };
}

router.post('/ghl-signup/:secret', async (req, res, next) => {
  const secret = process.env.GHL_SIGNUP_WEBHOOK_SECRET;
  if (!secret || !timingSafeEqual(req.params.secret, secret)) {
    return res.status(404).end(); // 404, not 401 -- don't confirm the endpoint even exists
  }

  const body = req.body || {};
  const { email, phone, businessName, contactName } = extractSignup(body);

  if (!email || !businessName) {
    await logSync({
      action: 'client.signup.webhook',
      entityType: 'client',
      request: body,
      success: false,
      error: `Missing ${!email ? 'email' : 'businessName'} in webhook payload`,
    });
    return res.status(400).json({ error: 'Could not find email/business name in payload', received: body });
  }

  const normalizedEmail = email.toLowerCase();

  try {
    const { data: existing } = await getSupabase()
      .from('clients')
      .select('id')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    if (existing) {
      await logSync({
        action: 'client.signup.webhook',
        entityType: 'client',
        entityId: existing.id,
        request: body,
        success: true,
        error: 'duplicate_skipped',
      });
      return res.status(200).json({ status: 'duplicate_skipped', clientId: existing.id });
    }

    const { data: client, error } = await getSupabase()
      .from('clients')
      .insert({ name: businessName, email: normalizedEmail, phone, contact_name: contactName })
      .select()
      .single();
    if (error) throw error;

    try {
      await inviteUserForClient({ email: normalizedEmail, clientId: client.id });
    } catch (inviteErr) {
      await getSupabase().from('clients').delete().eq('id', client.id);
      throw inviteErr;
    }

    await logSync({
      action: 'client.signup.webhook',
      entityType: 'client',
      entityId: client.id,
      request: body,
      success: true,
    });
    res.status(201).json({ status: 'created', clientId: client.id });
  } catch (err) {
    await logSync({
      action: 'client.signup.webhook',
      entityType: 'client',
      request: body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

module.exports = router;
