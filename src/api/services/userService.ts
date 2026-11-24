import { supabase } from '../../lib/supabase.js';

export const getUserProfile = async (uid: string): Promise<any> => {
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (profile) return profile;
  const { data: user } = await supabase.from('users').select('*').or(`id.eq.${uid},uid.eq.${uid}`).maybeSingle();
  return user || null;
};

const MAX_AVATAR_DATA_URL_LENGTH = 2 * 1024 * 1024; // 2 MB
const SAFE_AVATAR_DATA_URL_REGEX = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

export const validateAvatarUrl = (rawUrl: unknown): string => {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return '';

  if (trimmed.length > MAX_AVATAR_DATA_URL_LENGTH) {
    const err: any = new Error('Avatar URL or image data is too large.');
    err.statusCode = 400;
    throw err;
  }

  if (SAFE_AVATAR_DATA_URL_REGEX.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return trimmed;
    }
  } catch {
    // Fall through to validation error
  }

  const err: any = new Error(
    'Invalid avatar URL. Only HTTP(S) URLs or standard PNG/JPG/WEBP/GIF image data URLs are allowed.'
  );
  err.statusCode = 400;
  throw err;
};

export const updateUserProfile = async (uid: string, data: any): Promise<any> => {
  const allowedData: any = {
    updated_at: new Date().toISOString()
  };
  if (data.full_name !== undefined) allowedData.full_name = String(data.full_name || '').trim().slice(0, 120);
  if (data.phone !== undefined) allowedData.phone = String(data.phone || '').trim().slice(0, 40);
  if (data.country !== undefined) allowedData.country = String(data.country || '').trim().slice(0, 80);
  if (data.address !== undefined) allowedData.address = String(data.address || '').trim().slice(0, 300);
  if (data.avatar_url !== undefined) allowedData.avatar_url = validateAvatarUrl(data.avatar_url);

  let { data: updated, error } = await supabase.from('profiles').update(allowedData).eq('id', uid).select().maybeSingle();

  if (error && error.message?.includes('column')) {
    console.warn('[userService] Database schema pending migration for extended profile columns:', error.message);
    const fallbackData: any = { updated_at: new Date().toISOString() };
    if (data.full_name !== undefined) fallbackData.full_name = String(data.full_name || '').trim();
    if (data.phone !== undefined) fallbackData.phone = String(data.phone || '').trim();

    const retry = await supabase.from('profiles').update(fallbackData).eq('id', uid).select().maybeSingle();
    if (!retry.error) {
      return { ...retry.data, ...allowedData };
    }
  }

  if (error) {
    let { data: upserted, error: upsertErr } = await supabase.from('profiles').upsert({ id: uid, ...allowedData }, { onConflict: 'id' }).select().maybeSingle();
    if (upsertErr && upsertErr.message?.includes('column')) {
      const fallbackData: any = { id: uid, updated_at: new Date().toISOString() };
      if (data.full_name !== undefined) fallbackData.full_name = String(data.full_name || '').trim();
      if (data.phone !== undefined) fallbackData.phone = String(data.phone || '').trim();

      const retryUpsert = await supabase.from('profiles').upsert(fallbackData, { onConflict: 'id' }).select().maybeSingle();
      if (!retryUpsert.error) {
        return { ...retryUpsert.data, ...allowedData };
      }
      upsertErr = retryUpsert.error;
    }
    if (upsertErr) throw upsertErr;
    return upserted;
  }
  return updated;
};
