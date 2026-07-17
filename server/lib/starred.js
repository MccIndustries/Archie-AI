const ghl = require('./ghlClient');
const { getSupabase } = require('./supabase');

function locationId() {
  return ghl.getTenant()?.locationId || 'unknown';
}

async function listStarredIds() {
  const { data, error } = await getSupabase()
    .from('starred_conversations')
    .select('conversation_id')
    .eq('location_id', locationId());
  if (error) throw error;
  return new Set((data || []).map((r) => r.conversation_id));
}

async function starConversation({ conversationId, contactId, userEmail }) {
  const { error } = await getSupabase()
    .from('starred_conversations')
    .upsert(
      { location_id: locationId(), conversation_id: conversationId, contact_id: contactId || null, created_by: userEmail || null },
      { onConflict: 'location_id,conversation_id' }
    );
  if (error) throw error;
  try {
    await ghl.setConversationStarred(conversationId, true);
  } catch {
    // Best-effort mirror -- our own table is the real source of truth.
  }
}

async function unstarConversation(conversationId) {
  const { error } = await getSupabase()
    .from('starred_conversations')
    .delete()
    .eq('location_id', locationId())
    .eq('conversation_id', conversationId);
  if (error) throw error;
  try {
    await ghl.setConversationStarred(conversationId, false);
  } catch {
    // Best-effort mirror -- our own table is the real source of truth.
  }
}

module.exports = { listStarredIds, starConversation, unstarConversation };
