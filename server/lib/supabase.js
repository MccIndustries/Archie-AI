const { createClient } = require('@supabase/supabase-js');
const { getTenant } = require('./ghlClient');

let client;

function getSupabase() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
    }
    client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

async function logSync({ userEmail, action, entityType, entityId, request, success, error }) {
  try {
    await getSupabase()
      .from('sync_log')
      .insert({
        location_id: getTenant()?.locationId || null,
        user_email: userEmail || null,
        action,
        entity_type: entityType,
        entity_id: entityId || null,
        request: request || null,
        success,
        error: error || null,
      });
  } catch (e) {
    // Audit logging must never break the actual GHL sync operation.
    console.error('sync_log insert failed:', e.message);
  }
}

const JOB_FILES_BUCKET = 'job-files';
let bucketEnsured = false;

async function ensureJobFilesBucket() {
  if (bucketEnsured) return;
  const supabase = getSupabase();
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.some((b) => b.name === JOB_FILES_BUCKET)) {
    const { error } = await supabase.storage.createBucket(JOB_FILES_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
  bucketEnsured = true;
}

async function uploadJobFile({ jobId, filename, buffer, contentType, uploadedBy, category }) {
  await ensureJobFilesBucket();
  const supabase = getSupabase();
  const locationId = getTenant()?.locationId || 'unknown';
  // Prefixed by location so the shared bucket stays organized per client,
  // even though GHL's own IDs are unique enough that collisions aren't a
  // real risk.
  const path = `${locationId}/${jobId}/${Date.now()}-${filename}`;
  const { error: uploadErr } = await supabase.storage
    .from(JOB_FILES_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });
  if (uploadErr) throw uploadErr;

  const { error: insertErr } = await supabase
    .from('job_files')
    .insert({ location_id: locationId, job_id: jobId, path, content_type: contentType, uploaded_by: uploadedBy || null, category: category || null });
  if (insertErr) throw insertErr;

  return path;
}

async function listJobFiles(jobId) {
  const supabase = getSupabase();
  // Scoped by location_id too, not just job_id -- keeps this deployment
  // from ever being able to read another client's files even in a shared
  // Supabase project.
  const { data, error } = await supabase
    .from('job_files')
    .select('*')
    .eq('job_id', jobId)
    .eq('location_id', getTenant()?.locationId || 'unknown')
    .order('created_at', { ascending: false });
  if (error) throw error;

  const withUrls = await Promise.all(
    (data || []).map(async (row) => {
      const { data: signed } = await supabase.storage
        .from(JOB_FILES_BUCKET)
        .createSignedUrl(row.path, 60 * 10); // 10 minutes
      return { ...row, url: signed?.signedUrl || null };
    })
  );
  return withUrls;
}

module.exports = {
  getSupabase,
  logSync,
  ensureJobFilesBucket,
  uploadJobFile,
  listJobFiles,
};
