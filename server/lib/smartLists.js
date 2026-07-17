const ghl = require('./ghlClient');
const { getSupabase } = require('./supabase');

function locationId() {
  return ghl.getTenant()?.locationId || 'unknown';
}

async function listSmartLists() {
  const { data, error } = await getSupabase()
    .from('smart_lists')
    .select('*')
    .eq('location_id', locationId())
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function createSmartList({ name, filters, userEmail }) {
  const { data, error } = await getSupabase()
    .from('smart_lists')
    .insert({ location_id: locationId(), name, filters: filters || {}, created_by: userEmail || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateSmartList(id, { name, filters }) {
  const update = {};
  if (name !== undefined) update.name = name;
  if (filters !== undefined) update.filters = filters;
  const { data, error } = await getSupabase()
    .from('smart_lists')
    .update(update)
    .eq('id', id)
    .eq('location_id', locationId())
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteSmartList(id) {
  const { error } = await getSupabase().from('smart_lists').delete().eq('id', id).eq('location_id', locationId());
  if (error) throw error;
}

module.exports = { listSmartLists, createSmartList, updateSmartList, deleteSmartList };
