function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/* -------------------------------------------------------
   STRIPE SIGNATURE VERIFICATION
------------------------------------------------------- */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
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

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(byte =>
      byte
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
}

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
    parts.find(part =>
      part.startsWith("t=")
    );

  const signatures =
    parts
      .filter(part =>
        part.startsWith("v1=")
      )
      .map(part =>
        part.substring(3)
      );

  if (
    !timestampPart ||
    signatures.length === 0
  ) {
    return false;
  }

  const timestamp =
    timestampPart.substring(2);

  /*
    Reject very old webhook requests.
    Stripe's normal tolerance is about 5 minutes.
  */

  const timestampNumber =
    Number(timestamp);

  if (
    !Number.isFinite(
      timestampNumber
    )
  ) {
    return false;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  if (
    Math.abs(
      now - timestampNumber
    ) > 300
  ) {
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

  const expectedSignature =
    bytesToHex(
      new Uint8Array(
        signatureBuffer
      )
    );

  return signatures.some(
    signature =>
      timingSafeEqual(
        signature,
        expectedSignature
      )
  );
}

/* -------------------------------------------------------
   SUPABASE HELPERS
------------------------------------------------------- */

async function supabaseRequest(
  env,
  path,
  {
    method = "GET",
    body,
    headers = {},
  } = {}
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method,

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json",

          "content-type":
            "application/json",

          ...headers,
        },

        body:
          body === undefined
            ? undefined
            : JSON.stringify(body),
      }
    );

  const text =
    await response.text();

  let data = null;

  if (text) {
    try {
      data =
        JSON.parse(text);
    } catch {
      data =
        text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return data;
}

/* -------------------------------------------------------
   DONOR INFORMATION
------------------------------------------------------- */

function getDonorName(session) {
  const customer =
    session.customer_details;

  const name =
    String(
      customer?.name ||
      session.customer_name ||
      ""
    ).trim();

  return name || "Anonymous";
}

/* -------------------------------------------------------
   BASEBALL PAYMENT
------------------------------------------------------- */

async function processBaseballPayment(
  env,
  session
) {
  const metadata =
    session.metadata || {};

  const teamKey =
    String(
      metadata.team_key || ""
    ).trim();

  const playerKey =
    String(
      metadata.player_key || ""
    ).trim();

  const ballsString =
    String(
      metadata.balls || ""
    ).trim();

  if (
    !teamKey ||
    !playerKey ||
    !ballsString
  ) {
    throw new Error(
      "Missing baseball payment metadata."
    );
  }

  /*
    Extra protection:
    only process payments belonging
    to this Cloudflare project.
  */

  if (
    teamKey !==
    env.TEAM_KEY
  ) {
    throw new Error(
      `Webhook team mismatch. Received "${teamKey}".`
    );
  }

  /*
    Stripe metadata example:

    balls = "1,12,47"

    Convert to ordinary integers.
    Never send this value directly
    into a PostgreSQL array field.
  */

  const balls =
    [
      ...new Set(
        ballsString
          .split(",")
          .map(value =>
            Number(
              value.trim()
            )
          )
          .filter(
            number =>
              Number.isInteger(
                number
              ) &&
              number >= 1 &&
              number <= 100
          )
      ),
    ].sort(
      (a, b) => a - b
    );

  if (!balls.length) {
    throw new Error(
      "No valid baseball numbers found in Stripe metadata."
    );
  }

  const donorName =
    getDonorName(session);

  const sessionId =
    String(
      session.id || ""
    );

  const soldAt =
    new Date()
      .toISOString();

  /*
    Mark every baseball individually.

    This prevents PostgreSQL from ever
    interpreting something like "1"
    as an array literal.
  */

  for (
    const ballNumber
    of balls
  ) {
    const path =
      [
        "baseballs",
        `?team_key=eq.${encodeURIComponent(
          teamKey
        )}`,
        `&player_key=eq.${encodeURIComponent(
          playerKey
        )}`,
        `&ball_number=eq.${ballNumber}`,
      ].join("");

    const updatedRows =
      await supabaseRequest(
        env,
        path,
        {
          method: "PATCH",

          headers: {
            Prefer:
              "return=representation",
          },

          body: {
            sold: true,

            amount:
              ballNumber,

            donor_name:
              donorName,

            stripe_session_id:
              sessionId,

            sold_at:
              soldAt,
          },
        }
      );

    /*
      Normally all 100 baseball rows
      are already seeded.

      If a row somehow does not exist,
      create it.
    */

    if (
      !Array.isArray(
        updatedRows
      ) ||
      updatedRows.length === 0
    ) {
      await supabaseRequest(
        env,
        "baseballs?on_conflict=team_key,player_key,ball_number",
        {
          method: "POST",

          headers: {
            Prefer:
              "resolution=merge-duplicates,return=representation",
          },

          body: {
            team_key:
              teamKey,

            player_key:
              playerKey,

            ball_number:
              ballNumber,

            sold: true,

            amount:
              ballNumber,

            donor_name:
              donorName,

            stripe_session_id:
              sessionId,

            sold_at:
              soldAt,
          },
        }
      );
    }
  }

  /*
    Baseball payment total.

    We calculate it ourselves rather
    than trusting browser data.
  */

  const amount =
    balls.reduce(
      (total, number) =>
        total + number,
      0
    );

  /*
    Record the overall transaction.

    stripe_session_id should be UNIQUE,
    making duplicate Stripe webhook
    deliveries harmless.
  */

  await supabaseRequest(
    env,
    "donations?on_conflict=stripe_session_id",
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation",
      },

      body: {
        team_key:
          teamKey,

        player_key:
          playerKey,

        donation_type:
          "baseballs",

        amount,

        donor_name:
          donorName,

        stripe_session_id:
          sessionId,

        stripe_payment_intent_id:
          session.payment_intent
            ? String(
                session.payment_intent
              )
            : null,
      },
    }
  );

  return {
    teamKey,
    playerKey,
    balls,
    amount,
    donorName,
  };
}

/* -------------------------------------------------------
   GENERAL DONATION
------------------------------------------------------- */

async function processGeneralDonation(
  env,
  session
) {
  const metadata =
    session.metadata || {};

  const teamKey =
    String(
      metadata.team_key || ""
    ).trim();

  const donationType =
    String(
      metadata.donation_type || ""
    ).trim();

  if (!teamKey) {
    throw new Error(
      "Missing team metadata."
    );
  }

  if (
    teamKey !==
    env.TEAM_KEY
  ) {
    throw new Error(
      `Webhook team mismatch. Received "${teamKey}".`
    );
  }

  const validType =
    donationType ===
      "team_general" ||
    donationType ===
      "player_general";

  if (!validType) {
    throw new Error(
      `Invalid donation type: ${donationType}`
    );
  }

  const playerKey =
    donationType ===
    "player_general"
      ? String(
          metadata.player_key ||
          ""
        ).trim()
      : null;

  if (
    donationType ===
      "player_general" &&
    !playerKey
  ) {
    throw new Error(
      "Player donation is missing player_key."
    );
  }

  /*
    Use Stripe's actual amount paid.

    amount_total is stored in cents.
  */

  const stripeAmount =
    Number(
      session.amount_total
    );

  const amount =
    Number.isFinite(
      stripeAmount
    )
      ? stripeAmount / 100
      : Number(
          metadata.amount
        );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Invalid general donation amount."
    );
  }

  const donorName =
    getDonorName(session);

  const sessionId =
    String(
      session.id || ""
    );

  await supabaseRequest(
    env,
    "donations?on_conflict=stripe_session_id",
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation",
      },

      body: {
        team_key:
          teamKey,

        player_key:
          playerKey,

        donation_type:
          donationType,

        amount,

        donor_name:
          donorName,

        stripe_session_id:
          sessionId,

        stripe_payment_intent_id:
          session.payment_intent
            ? String(
                session.payment_intent
              )
            : null,
      },
    }
  );

  return {
    teamKey,
    playerKey,
    donationType,
    amount,
    donorName,
  };
}

/* -------------------------------------------------------
   MAIN WEBHOOK
------------------------------------------------------- */

export async function onRequestPost({
  request,
  env,
}) {
  try {
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
            "Missing webhook server configuration.",
        },
        500
      );
    }

    /*
      IMPORTANT:
      Stripe verification requires the
      exact raw request body.
    */

    const rawBody =
      await request.text();

    const stripeSignature =
      request.headers.get(
        "stripe-signature"
      );

    const validSignature =
      await verifyStripeSignature(
        rawBody,
        stripeSignature,
        env.STRIPE_WEBHOOK_SECRET
      );

    if (!validSignature) {
      return json(
        {
          success: false,
          error:
            "Invalid Stripe signature.",
        },
        400
      );
    }

    let event;

    try {
      event =
        JSON.parse(rawBody);
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid Stripe event.",
        },
        400
      );
    }

    /*
      We only need successful Checkout
      payments for this fundraiser.
    */

    if (
      event.type !==
        "checkout.session.completed" &&
      event.type !==
        "checkout.session.async_payment_succeeded"
    ) {
      return json({
        success: true,
        received: true,
        ignored: true,
        eventType:
          event.type,
      });
    }

    const session =
      event?.data?.object;

    if (!session) {
      throw new Error(
        "Stripe event is missing checkout session."
      );
    }

    /*
      checkout.session.completed can occur
      before some delayed payment methods
      actually settle.

      Only process completed payments.
    */

    if (
      session.payment_status &&
      session.payment_status !==
        "paid"
    ) {
      return json({
        success: true,
        received: true,
        ignored: true,
        reason:
          "Payment is not paid yet.",
      });
    }

    const metadata =
      session.metadata || {};

    const donationType =
      String(
        metadata.donation_type || ""
      ).trim();

    let result;

    if (
      donationType ===
      "baseballs"
    ) {
      result =
        await processBaseballPayment(
          env,
          session
        );
    } else if (
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
    } else {
      return json({
        success: true,
        received: true,
        ignored: true,
        reason:
          "Unknown donation type.",
      });
    }

    return json({
      success: true,
      received: true,
      processed: true,

      eventId:
        event.id,

      donationType,

      result,
    });

  } catch (error) {
    console.error(
      "Webhook processing error:",
      error
    );

    /*
      Returning 500 tells Stripe to retry
      the webhook automatically.
    */

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
