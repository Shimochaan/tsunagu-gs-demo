/** Keep the original work alive if LINE or TimeRex closes its webhook connection.
 * This does not replay an event or retry a customer send.
 */
export function retainStaffWebhook<T>(
  request: Request,
  pending: Promise<T>,
  context?: Pick<ExecutionContext, "waitUntil">,
): Promise<T> {
  const path = new URL(request.url).pathname;
  if ((path === "/webhooks/staff-line" || /^\/webhooks\/timerex\/[^/]+$/.test(path)) && context)
    context.waitUntil(pending.then(() => undefined));
  return pending;
}
