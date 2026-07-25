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
    email: userEmail,
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

    if (error) {
      console.error(`[NotificationService] Exact database error when inserting notification for ${userEmail}:`, error.message || error, JSON.stringify(error));
      
      if (error.code === 'PGRST204' || error.message?.includes('column')) {
        // Retry with minimal payload if schema has fewer columns
        const fallbackPayload = {
          user_id: userId || null,
          user_email: userEmail,
          email: userEmail,
          title,
          message,
          created_at: new Date().toISOString()
        };
        const { data: retryData, error: retryErr } = await supabaseAdmin.from('notifications').insert(fallbackPayload).select().maybeSingle();
        if (retryErr) {
          console.error(`[NotificationService] Fallback notification insert failed for ${userEmail}:`, retryErr.message || retryErr, JSON.stringify(retryErr));
          return null;
        }
        return retryData;
      }
      return null;
    }

    return data;
  } catch (err: any) {
    console.error(`[NotificationService] Exception during notification insert for ${userEmail}:`, err.message || err, JSON.stringify(err));
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
