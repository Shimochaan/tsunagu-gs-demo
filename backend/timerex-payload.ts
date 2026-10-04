import { z } from "zod";
import type { BookingEventPayload } from "./booking.ts";

const text = z.string().max(5000);
const bookingSchema = z.object({
  event: z.enum(["booking.created", "booking.rescheduled", "booking.cancelled"]),
  bookingId: text.min(1), title: text.default("個別面談"),
  startsAt: z.iso.datetime({ offset: true }).transform(v => new Date(v).toISOString()),
  endsAt: z.iso.datetime({ offset: true }).optional().transform(v => v ? new Date(v).toISOString() : undefined),
  guestName: text.default("お客様"), guestEmail: text.default(""),
  guestPhone: text.optional(), trackingToken: text.optional(), customerId: text.optional(),
  lineUserId: text.optional(), staffName: text.optional(), location: text.optional(),
  hostEmails: z.array(z.email().transform(v => v.toLowerCase())).max(100).default([]),
  detailsUrl: z.url().refine(v => v.startsWith("https://")).optional(),
});

// TimeRex公式形式: webhook_type + event。既存の内部連携形式も受け付ける。
export function normalizeTimeRexPayload(raw: any): BookingEventPayload {
  if (raw?.webhook_type) {
    const type = z.enum(["event_confirmed", "event_cancelled"]).parse(raw.webhook_type);
    const d = raw.event || {};
    const form = Array.isArray(d.form) ? d.form : [];
    const field = (name: string) => form.find((f: any) => f.field_type === name)?.value;
    const params = Array.isArray(d.url_params) ? Object.assign({}, ...d.url_params) : (d.url_params || {});
    return bookingSchema.parse({
      event: type === "event_cancelled" ? "booking.cancelled" : "booking.created",
      bookingId: d.id, title: raw.calendar_name,
      startsAt: d.start_datetime, endsAt: d.end_datetime,
      guestName: field("guest_name"), guestEmail: field("guest_email"),
      staffName: Array.isArray(d.hosts) ? d.hosts.map((h: any) => h.name).filter(Boolean).join("・") : undefined,
      hostEmails: Array.isArray(d.hosts) ? d.hosts.map((h: any) => h.email).filter(Boolean) : [],
      location: d.online_meeting_provider || "オンライン",
      detailsUrl: d.guest_cancel_url || raw.calendar_url,
      trackingToken: params.tracking_token || params.trackingToken,
      // URLパラメータ内の任意のcustomerId/LINE IDは配送先として信頼しない。
    });
  }
  if (raw?.data && typeof raw.data === "object") {
    const d = raw.data;
    return bookingSchema.parse({
      event: raw.event, bookingId: d.id || d.booking_id,
      title: d.title, startsAt: d.start_time || d.starts_at || d.startsAt,
      endsAt: d.end_time || d.ends_at || d.endsAt,
      guestName: d.guest?.name || d.guestName, guestEmail: d.guest?.email || d.guestEmail,
      guestPhone: d.guest?.phone_number || d.guest?.phone || d.guestPhone,
      staffName: d.host?.name || d.staffName, hostEmails: d.host?.email ? [d.host.email] : (d.hostEmails || []), location: d.location || d.place,
      detailsUrl: d.url || d.detailsUrl,
      trackingToken: d.custom_fields?.tracking_token || d.custom_fields?.trackingToken || d.trackingToken,
      customerId: d.custom_fields?.customer_id || d.custom_fields?.customerId || d.customerId,
      lineUserId: d.custom_fields?.line_user_id || d.custom_fields?.lineUserId || d.lineUserId,
    });
  }
  return bookingSchema.parse(raw);
}
