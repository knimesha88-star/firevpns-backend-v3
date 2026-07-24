import { supabaseAdmin } from '../../lib/supabase.js';

export interface CreateNotificationParams {
  userId?: string | null;
  userEmail: string;
  title: string;
  message: string;
  type?: string;
  orderId?: string | null;
}

export const createCustomerNotification = async (params: CreateNotificationParams): Promise<any> => {
  const { userId, userEmail, title, message, type = 'info', orderId } = params;

  const payload: any = {
    user_id: userId || null,
    user_email: userEmail,
    title,
    message,
    type,
    read: false,
    is_read: false,
    order_id: orderId || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  try {
    let { data, error } = await supabaseAdmin.from('notifications').insert(payload).select().maybeSingle();

    if (error && (error.code === 'PGRST204' || error.message?.includes('column'))) {
      // Retry without optional columns if schema has fewer columns
      delete payload.is_read;
      delete payload.order_id;
      delete payload.type;
      delete payload.updated_at;
      const { data: retryData, error: retryErr } = await supabaseAdmin.from('notifications').insert(payload).select().maybeSingle();
      data = retryData;
      error = retryErr;
    }

    if (error) {
      console.warn('[NotificationService] Notice inserting notification into DB:', error.message || error);
      return null;
    }

    console.log('[NotificationService] Customer notification created successfully:', title, 'for', userEmail);
    return data;
  } catch (err: any) {
    console.warn('[NotificationService] Exception creating notification:', err.message || err);
    return null;
  }
};

export const getUserNotifications = async (userId?: string, userEmail?: string): Promise<any[]> => {
  try {
    const { data: allNotifs, error } = await supabaseAdmin.from('notifications').select('*').order('created_at', { ascending: false });
    if (error || !allNotifs) return [];

    const uId = userId ? String(userId).trim() : '';
    const uEmail = userEmail ? String(userEmail).toLowerCase().trim() : '';

    return allNotifs.filter((item: any) => {
      const itemUserId = String(item.user_id || '').trim();
      const itemEmail = String(item.user_email || item.email || '').toLowerCase().trim();
      return (uId && itemUserId === uId) || (uEmail && itemEmail === uEmail);
    });
  } catch (err) {
    console.warn('[NotificationService] Error fetching notifications:', err);
    return [];
  }
};

export const markNotificationAsRead = async (notificationId: string): Promise<boolean> => {
  try {
    const { error } = await supabaseAdmin.from('notifications').update({
      read: true,
      is_read: true,
      updated_at: new Date().toISOString()
    }).eq('id', notificationId);
    return !error;
  } catch (err) {
    console.warn('[NotificationService] Error marking notification as read:', err);
    return false;
  }
};
