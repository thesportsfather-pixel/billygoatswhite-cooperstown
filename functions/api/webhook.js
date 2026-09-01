function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// ============================================================
// HEX / CRYPTO HELPERS
// ============================================================

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return result === 0;
}

// ============================================================
// VERIFY STRIPE SIGNATURE
// ============================================================

async function verifyStripeSignature(
  payload,
  signatureHeader,
  webhookSecret
) {
  if (
    !payload ||
    !signatureHeader ||
    !webhookSecret
  ) {
    return false;
  }

  const parts =
    signatureHeader.split(",");

  const timestampPart =
    parts.find((part) =>
      part.startsWith("t=")
    );

  const signatures =
    parts
      .filter((part) =>
        part.startsWith("v1=")
      )
      .map((part) =>
        part.substring(3)
      );

  if (
    !timestampPart ||
    !signatures.length
  ) {
    return false;
  }

  const timestamp =
    timestampPart.substring(2);

  // Reject very old webhook requests.
  const timestampNumber =
    Number(timestamp);

  if (
    !Number.isFinite(timestampNumber)
  ) {
    return false;
  }

  const ageSeconds =
    Math.abs(
      Math.floor(Date.now() / 1000) -
      timestampNumber
    );

  if (ageSeconds > 300) {
    return false;
  }

  const signedPayload =
    `${timestamp}.${payload}`;

  const encoder =
    new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(
        webhookSecret
      ),
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );

  const signatureBuffer =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(
        signedPayload
      )
    );

  const expected =
    bytesToHex(
      new Uint8Array(
        signatureBuffer
      )
    );

  return signatures.some(
    (signature) =>
      safeEqual(
        signature,
        expected
      )
  );
}

// ============================================================
// SUPABASE HELPERS
// ============================================================

function supabaseHeaders(env, extra = {}) {
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY;

  return {
    apikey: key,
    authorization:
      `Bearer ${key}`,
    "content-type":
      "application/json",
    ...extra,
  };
}

async function supabaseGet(
  env,
  path
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        headers:
          supabaseHeaders(
            env
          ),
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase GET ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : [];
}

async function supabasePatch(
  env,
  path,
  data
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method: "PATCH",

        headers:
          supabaseHeaders(
            env,
            {
              Prefer:
                "return=representation",
            }
          ),

        body:
          JSON.stringify(data),
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase PATCH ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : [];
}

async function supabaseUpsert(
  env,
  table,
  data,
  conflictColumn
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(
        conflictColumn
      )}`,
      {
        method: "POST",

        headers:
          supabaseHeaders(
            env,
            {
              Prefer:
                "resolution=merge-duplicates,return=representation",
            }
          ),

        body:
          JSON.stringify(data),
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase UPSERT ${response.status}: ${text}`
    );
  }

  return text
    ? JSON.parse(text)
    : [];
}

// ============================================================
// PARSE BALL NUMBERS
//
// Stripe metadata looks like:
//
// "1,12,47"
//
// NOT:
// "{1,12,47}"
//
// This prevents the PostgreSQL malformed-array issue.
// ============================================================

function parseBalls(value) {
  if (!value) {
    return [];
  }

  return [
    ...new Set(
      String(value)
        .split(",")
        .map((value) =>
          Number(
            value.trim()
          )
        )
        .filter(
          (value) =>
            Number.isInteger(value) &&
            value >= 1 &&
            value <= 100
        )
    ),
  ].sort(
    (a, b) => a - b
  );
}

// ============================================================
// DONOR INFO
// ============================================================

function getDonorName(session) {
  const details =
    session.customer_details;

  if (
    details?.name &&
    details.name.trim()
  ) {
    return details.name.trim();
  }

  if (
    session.customer_email
  ) {
    return session.customer_email;
  }

  return "Anonymous";
}

function getDonorEmail(session) {
  return (
    session.customer_details?.email ||
    session.customer_email ||
    null
  );
}

// ============================================================
// RECORD DONATION
//
// The next setup step creates the donations table expected here.
// ============================================================

async function recordDonation(
  env,
  {
    session,
    teamKey,
    teamId,
    playerId,
    playerKey,
    donationType,
    amountCents,
    donorName,
    donorEmail,
    balls,
  }
) {
  const row = {
    team_key:
      teamKey,

    team_id:
      teamId || null,

    player_id:
      playerId || null,

    player_key:
      playerKey || null,

    donation_type:
      donationType,

    amount_cents:
      amountCents,

    donor_name:
      donorName,

    donor_email:
      donorEmail,

    stripe_session_id:
      session.id,

    stripe_payment_intent_id:
      typeof session.payment_intent ===
      "string"
        ? session.payment_intent
        : null,

    balls:
      balls.length
        ? balls.join(",")
        : null,
  };

  return await supabaseUpsert(
    env,
    "donations",
    row,
    "stripe_session_id"
  );
}

// ============================================================
// PROCESS BASEBALL PAYMENT
// ============================================================

async function processBaseballDonation(
  env,
  session
) {
  const metadata =
    session.metadata || {};

  const teamKey =
    metadata.team_key ||
    env.TEAM_KEY;

  const playerId =
    metadata.player_id;

  const playerKey =
    metadata.player_key;

  const balls =
    parseBalls(
      metadata.balls
    );

  if (
    !teamKey ||
    !playerId ||
    !playerKey
  ) {
    throw new Error(
      "Baseball payment is missing required metadata."
    );
  }

  if (!balls.length) {
    throw new Error(
      "Baseball payment contains no valid baseball numbers."
    );
  }

  // --------------------------------------------------------
  // Verify team
  // --------------------------------------------------------

  const teamRows =
    await supabaseGet(
      env,
      [
        "teams",
        "?select=id,team_key,team_name",
        `&team_key=eq.${encodeURIComponent(
          teamKey
        )}`,
        "&limit=1",
      ].join("")
    );

  if (!teamRows.length) {
    throw new Error(
      "Webhook team not found."
    );
  }

  const team =
    teamRows[0];

  // --------------------------------------------------------
  // Verify player really belongs to team
  // --------------------------------------------------------

  const playerRows =
    await supabaseGet(
      env,
      [
        "players",
        "?select=id,player_key,player_name,player_number",
        `&id=eq.${encodeURIComponent(
          playerId
        )}`,
        `&team_id=eq.${encodeURIComponent(
          team.id
        )}`,
        "&limit=1",
      ].join("")
    );

  if (!playerRows.length) {
    throw new Error(
      "Webhook player not found for this team."
    );
  }

  const player =
    playerRows[0];

  if (
    player.player_key !==
    playerKey
  ) {
    throw new Error(
      "Player metadata does not match database."
    );
  }

  const donorName =
    getDonorName(
      session
    );

  const donorEmail =
    getDonorEmail(
      session
    );

  const soldAt =
    new Date().toISOString();

  let expectedTotalCents = 0;

  // --------------------------------------------------------
  // Process each baseball individually
  // --------------------------------------------------------

  for (const ballNumber of balls) {
    const existingRows =
      await supabaseGet(
        env,
        [
          "baseballs",
          "?select=id,player_id,ball_number,amount_cents,status,stripe_session_id",
          `&player_id=eq.${encodeURIComponent(
            player.id
          )}`,
          `&ball_number=eq.${ballNumber}`,
          "&limit=1",
        ].join("")
      );

    if (!existingRows.length) {
      throw new Error(
        `Baseball #${ballNumber} was not found.`
      );
    }

    const existing =
      existingRows[0];

    expectedTotalCents +=
      Number(
        existing.amount_cents || 0
      );

    const status =
      String(
        existing.status || ""
      ).toLowerCase();

    // ------------------------------------------------------
    // Already processed by THIS Stripe session
    // ------------------------------------------------------

    if (
      status === "sold" &&
      existing.stripe_session_id ===
        session.id
    ) {
      continue;
    }

    // ------------------------------------------------------
    // Already sold by ANOTHER checkout
    // ------------------------------------------------------

    if (status === "sold") {
      console.error(
        `PAYMENT CONFLICT: Baseball #${ballNumber} for ${playerKey} is already sold by session ${existing.stripe_session_id}. Incoming session: ${session.id}`
      );

      // Do not overwrite the first donor.
      continue;
    }

    // ------------------------------------------------------
    // Mark ball SOLD
    // ------------------------------------------------------

    const updated =
      await supabasePatch(
        env,
        [
          "baseballs",
          `?id=eq.${encodeURIComponent(
            existing.id
          )}`,
          "&status=neq.sold",
        ].join(""),
        {
          status:
            "sold",

          donor_name:
            donorName,

          donor_email:
            donorEmail,

          stripe_session_id:
            session.id,

          sold_at:
            soldAt,

          reserved_until:
            null,

          reservation_id:
            null,
        }
      );

    if (!updated.length) {
      // Recheck in case webhook retry / concurrent request.
      const recheck =
        await supabaseGet(
          env,
          [
            "baseballs",
            "?select=status,stripe_session_id",
            `&id=eq.${encodeURIComponent(
              existing.id
            )}`,
            "&limit=1",
          ].join("")
        );

      if (
        recheck[0]?.status !==
        "sold"
      ) {
        throw new Error(
          `Unable to mark baseball #${ballNumber} as sold.`
        );
      }
    }
  }

  // --------------------------------------------------------
  // Verify Stripe amount
  // --------------------------------------------------------

  const paidCents =
    Number(
      session.amount_total || 0
    );

  if (
    expectedTotalCents > 0 &&
    paidCents !==
      expectedTotalCents
  ) {
    console.error(
      `Amount mismatch for session ${session.id}. Stripe=${paidCents}, Baseballs=${expectedTotalCents}`
    );
  }

  // --------------------------------------------------------
  // Record transaction
  // --------------------------------------------------------

  try {
    await recordDonation(
      env,
      {
        session,

        teamKey,

        teamId:
          team.id,

        playerId:
          player.id,

        playerKey:
          player.player_key,

        donationType:
          "baseballs",

        amountCents:
          paidCents,

        donorName,

        donorEmail,

        balls,
      }
    );
  } catch (error) {
    /*
     * Baseball records already contain the critical
     * payment/donor data, so do NOT undo a successful
     * baseball sale if donation logging has a problem.
     */
    console.error(
      "Unable to record baseball donation row:",
      error
    );
  }

  return {
    type:
      "baseballs",

    player:
      player.player_key,

    balls,

    amountCents:
      paidCents,
  };
}

// ============================================================
// PROCESS TEAM / PLAYER GENERAL DONATION
// ============================================================

async function processGeneralDonation(
  env,
  session
) {
  const metadata =
    session.metadata || {};

  const teamKey =
    metadata.team_key ||
    env.TEAM_KEY;

  const donationType =
    metadata.donation_type;

  if (
    donationType !==
      "team_general" &&
    donationType !==
      "player_general"
  ) {
    throw new Error(
      "Unknown general donation type."
    );
  }

  const teamRows =
    await supabaseGet(
      env,
      [
        "teams",
        "?select=id,team_key,team_name",
        `&team_key=eq.${encodeURIComponent(
          teamKey
        )}`,
        "&limit=1",
      ].join("")
    );

  if (!teamRows.length) {
    throw new Error(
      "Donation team not found."
    );
  }

  const team =
    teamRows[0];

  let player =
    null;

  // --------------------------------------------------------
  // Player-specific donation
  // --------------------------------------------------------

  if (
    donationType ===
    "player_general"
  ) {
    const playerId =
      metadata.player_id;

    const playerKey =
      metadata.player_key;

    if (
      !playerId ||
      !playerKey
    ) {
      throw new Error(
        "Player donation is missing player metadata."
      );
    }

    const playerRows =
      await supabaseGet(
        env,
        [
          "players",
          "?select=id,player_key,player_name,player_number",
          `&id=eq.${encodeURIComponent(
            playerId
          )}`,
          `&team_id=eq.${encodeURIComponent(
            team.id
          )}`,
          "&limit=1",
        ].join("")
      );

    if (!playerRows.length) {
      throw new Error(
        "Player donation player not found."
      );
    }

    player =
      playerRows[0];
  }

  const donorName =
    getDonorName(
      session
    );

  const donorEmail =
    getDonorEmail(
      session
    );

  const amountCents =
    Number(
      session.amount_total || 0
    );

  await recordDonation(
    env,
    {
      session,

      teamKey,

      teamId:
        team.id,

      playerId:
        player?.id ||
        null,

      playerKey:
        player?.player_key ||
        null,

      donationType,

      amountCents,

      donorName,

      donorEmail,

      balls: [],
    }
  );

  return {
    type:
      donationType,

    player:
      player?.player_key ||
      null,

    amountCents,
  };
}

// ============================================================
// MAIN WEBHOOK
// ============================================================

export async function onRequestPost({
  request,
  env,
}) {
  try {
    // ------------------------------------------------------
    // Required config
    // ------------------------------------------------------

    if (
      !env.STRIPE_WEBHOOK_SECRET ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY
    ) {
      return json(
        {
          success: false,
          error:
            "Missing webhook configuration.",
        },
        500
      );
    }

    // ------------------------------------------------------
    // IMPORTANT:
    // Read raw body BEFORE parsing JSON.
    // Stripe signature verification requires exact raw body.
    // ------------------------------------------------------

    const rawBody =
      await request.text();

    const signature =
      request.headers.get(
        "stripe-signature"
      );

    const verified =
      await verifyStripeSignature(
        rawBody,
        signature,
        env.STRIPE_WEBHOOK_SECRET
      );

    if (!verified) {
      console.error(
        "Invalid Stripe webhook signature."
      );

      return json(
        {
          success: false,
          error:
            "Invalid Stripe signature.",
        },
        400
      );
    }

    // ------------------------------------------------------
    // Parse event
    // ------------------------------------------------------

    let event;

    try {
      event =
        JSON.parse(
          rawBody
        );
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid webhook payload.",
        },
        400
      );
    }

    // ------------------------------------------------------
    // Only handle payment-success events we subscribed to
    // ------------------------------------------------------

    const supportedEvents =
      new Set([
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ]);

    if (
      !supportedEvents.has(
        event.type
      )
    ) {
      return json({
        received: true,
        ignored: true,
        eventType:
          event.type,
      });
    }

    const session =
      event.data?.object;

    if (!session?.id) {
      return json(
        {
          success: false,
          error:
            "Missing Checkout Session.",
        },
        400
      );
    }

    // ------------------------------------------------------
    // Only process paid sessions
    // ------------------------------------------------------

    if (
      session.payment_status !==
      "paid"
    ) {
      return json({
        received: true,
        ignored: true,
        reason:
          "Session is not paid.",
        paymentStatus:
          session.payment_status,
      });
    }

    const metadata =
      session.metadata || {};

    // ------------------------------------------------------
    // SECURITY:
    // This Cloudflare project should only process its team.
    // ------------------------------------------------------

    if (
      metadata.team_key &&
      metadata.team_key !==
        env.TEAM_KEY
    ) {
      console.error(
        "Webhook team mismatch:",
        metadata.team_key,
        env.TEAM_KEY
      );

      return json(
        {
          success: false,
          error:
            "Webhook team mismatch.",
        },
        400
      );
    }

    const donationType =
      metadata.donation_type;

    let result;

    // ------------------------------------------------------
    // Baseball sponsorship
    // ------------------------------------------------------

    if (
      donationType ===
      "baseballs"
    ) {
      result =
        await processBaseballDonation(
          env,
          session
        );
    }

    // ------------------------------------------------------
    // Team/player custom donation
    // ------------------------------------------------------

    else if (
      donationType ===
        "team_general" ||
      donationType ===
        "player_general"
    ) {
      result =
        await processGeneralDonation(
          env,
          session
        );
    }

    // ------------------------------------------------------
    // Unknown checkout type
    // ------------------------------------------------------

    else {
      return json({
        received: true,
        ignored: true,
        reason:
          "Unknown donation type.",
        donationType:
          donationType || null,
      });
    }

    // ------------------------------------------------------
    // SUCCESS
    // ------------------------------------------------------

    return json({
      success: true,
      received: true,
      eventType:
        event.type,
      sessionId:
        session.id,
      result,
    });
  } catch (error) {
    console.error(
      "Webhook processing failed:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Webhook processing failed.",
        details:
          error?.message ||
          String(error),
      },
      500
    );
  }
}
