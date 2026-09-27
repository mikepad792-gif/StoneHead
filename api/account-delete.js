// POST /api/account/delete
// Body: { confirm: "delete" }
// Response: { success: true }
//
// Deletes the signed-in user's account. The user can only ever delete
// themselves: the id comes from the session, never from the body.
//
// ORDER: database first (delete_account, migration 016), login second. If the
// login delete fails, the data is already gone and the user just can't finish
// logging out, which is the safe failure. The reverse order could leave a
// full data set behind with no way to reach it.
//
// IDEMPOTENT: a retry after a half-finished attempt finds the users row gone
// (deleted: false) and still removes the login.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }
  const { user_id } = auth;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
  if (confirm !== "delete") {
    return errorResponse(400, 'type "delete" to confirm');
  }

  const { data, error: rpcError } = await supabaseAdmin.rpc("delete_account", { p_user_id: user_id });
  if (rpcError) {
    console.error("account delete failed:", rpcError.message);
    return errorResponse(500, "couldn't delete your account. try again in a sec");
  }

  const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(user_id);
  // A login that's already gone (an earlier attempt got this far) is success.
  if (authError && authError.status !== 404) {
    console.error("account delete: login removal failed:", authError.message);
    return errorResponse(500, "almost done. try again to finish deleting your login");
  }

  // Never the user id, email, or username.
  console.log(JSON.stringify({ event: "account_deleted", retained: data?.retained ?? 0 }));
  return jsonResponse(200, { success: true });
}
