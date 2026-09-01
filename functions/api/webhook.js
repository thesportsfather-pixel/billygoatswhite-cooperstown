function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}


/* =========================================================
   HEX / SIGNATURE HELPERS
========================================================= */

function bytesToHex(bytes) {

  return Array
    .from(bytes)
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");

}


function timingSafeEqual(
  a,
  b
) {

  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
    return false;
  }

  let result = 0;

  for (
    let i = 0;
    i < a.length;
    i++
  ) {

    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);

  }

  return result === 0;

}


/* =========================================================
   VERIFY STRIPE SIGNATURE
========================================================= */

async function verifyStripeSignature(
  payload,
  signatureHeader,
  secret
) {

  if (
    !payload ||
    !signatureHeader ||
    !secret
  ) {
    return false;
  }


  const parts =
    signatureHeader.split(",");


  const timestampPart =
    parts.find(
      part =>
        part.startsWith("t=")
    );


  const signatures =
    parts
      .filter(
        part =>
          part.startsWith("v1=")
      )
      .map(
        part =>
          part.slice(3)
      );


  if (
    !timestampPart ||
    !signatures.length
  ) {
    return false;
  }


  const timestamp =
    timestampPart.slice(2);


  const timestampNumber =
    Number(timestamp);


  if (
    !Number.isFinite(
      timestampNumber
    )
  ) {
    return false;
  }


  /*
    Stripe recommends rejecting
    signatures that are too old.
  */

  const now =
    Math.floor(
      Date.now() / 1000
    );


  if (
    Math.abs(
      now -
      timestampNumber
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
      encoder.encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
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


/* =========================================================
   SUPABASE REQUEST
========================================================= */

async function supabaseRequest(
  env,
  path,
  options = {}
) {

  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json",

          ...options.headers
        }
      }
    );


  const text =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Supabase ${response.status}: ${text}`
    );

  }


  if (
    !text
  ) {
    return null;
  }


  try {

    return JSON.parse(text);

  } catch {

    return text;

  }

}


/* =========================================================
   GET TEAM
========================================================= */

async function getTeam(
  env,
  teamKey
) {

  const teams =
    await supabaseRequest(
      env,
      `teams?team_key=eq.${encodeURIComponent(
        teamKey
      )}&select=id,team_key,team_name&limit=1`
    );


  if (
    !Array.isArray(teams) ||
    !teams.length
  ) {

    throw new Error(
      `Team not found: ${teamKey}`
    );

  }


  return teams[0];

}


/* =========================================================
   GET PLAYER
========================================================= */

async function getPlayer(
  env,
  teamId,
  playerKey
) {

  const players =
    await supabaseRequest(
      env,
      `players?team_id=eq.${encodeURIComponent(
        teamId
      )}&player_key=eq.${encodeURIComponent(
        playerKey
      )}&select=id,player_key,player_name,player_number&limit=1`
    );


  if (
    !Array.isArray(players) ||
    !players.length
  ) {

    throw new Error(
      `Player not found: ${playerKey}`
    );

  }


  return players[0];

}


/* =========================================================
   PARSE BASEBALL NUMBERS
========================================================= */

function parseBaseballs(metadata) {

  const raw =
    metadata?.balls ||
    metadata?.baseball_numbers ||
    "";


  return Array.from(
    new Set(
      String(raw)
        .split(",")
        .map(
          value =>
            Number(
              value.trim()
            )
        )
        .filter(
          value =>
            Number.isInteger(value) &&
            value >= 1 &&
            value <= 100
        )
    )
  ).sort(
    (
      a,
      b
    ) =>
      a - b
  );

}


/* =========================================================
   DONOR NAME
========================================================= */

function getDonorName(
  session
) {

  const metadata =
    session.metadata || {};


  const anonymous =
    String(
      metadata.anonymous ||
      ""
    ).toLowerCase() ===
    "true";


  if (
    anonymous
  ) {

    return "Anonymous";

  }


  const metadataName =
    String(
      metadata.donor_name ||
      ""
    )
      .trim()
      .replace(
        /\s+/g,
        " "
      );


  if (
    metadataName
  ) {

    return metadataName.slice(
      0,
      50
    );

  }


  /*
    Compatibility fallback for any
    older checkout sessions.
  */

  const stripeName =
    String(
      session
        ?.customer_details
        ?.name ||
      ""
    )
      .trim()
      .replace(
        /\s+/g,
        " "
      );


  if (
    stripeName
  ) {

    return stripeName.slice(
      0,
      50
    );

  }


  return "Anonymous";

}


/* =========================================================
   DONOR EMAIL
========================================================= */

function getDonorEmail(
  session
) {

  return String(
    session
      ?.customer_details
      ?.email ||
    session
      ?.customer_email ||
    ""
  )
    .trim()
    .slice(
      0,
      320
    );

}


/* =========================================================
   RECORD DONATION

   Donation logging is kept separate
   from baseball fulfillment so a
   donation-table issue never prevents
   the baseball from being marked sold.
========================================================= */

async function recordDonation(
  env,
  {
    teamKey,
    teamId,
    playerId,
    playerKey,
    donationType,
    amountCents,
    donorName,
    donorEmail,
    sessionId,
    paymentIntentId,
    balls
  }
) {

  const payload = {

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
      donorEmail || null,

    stripe_session_id:
      sessionId,

    stripe_payment_intent_id:
      paymentIntentId || null,

    balls:
      balls?.length
        ? balls.join(",")
        : null

  };


  return supabaseRequest(
    env,
    "donations?on_conflict=stripe_session_id",
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json",

        prefer:
          "resolution=merge-duplicates,return=representation"
      },

      body:
        JSON.stringify(
          payload
        )
    }
  );

}


/* =========================================================
   PROCESS BASEBALL PURCHASE
========================================================= */

async function processBaseballPurchase(
  env,
  session
) {

  const metadata =
    session.metadata || {};


  const teamKey =
    String(
      metadata.team_key ||
      env.TEAM_KEY ||
      ""
    ).trim();


  const playerKey =
    String(
      metadata.player_key ||
      ""
    ).trim();


  if (
    !teamKey
  ) {

    throw new Error(
      "Missing team_key in Stripe metadata."
    );

  }


  if (
    teamKey !==
    env.TEAM_KEY
  ) {

    throw new Error(
      "Stripe team_key does not match this fundraiser."
    );

  }


  if (
    !playerKey
  ) {

    throw new Error(
      "Missing player_key in Stripe metadata."
    );

  }


  const baseballNumbers =
    parseBaseballs(
      metadata
    );


  if (
    !baseballNumbers.length
  ) {

    throw new Error(
      "No baseball numbers found in Stripe metadata."
    );

  }


  const team =
    await getTeam(
      env,
      teamKey
    );


  const player =
    await getPlayer(
      env,
      team.id,
      playerKey
    );


  /*
    Extra verification:
    if checkout metadata contains IDs,
    make sure they match our database.
  */

  if (
    metadata.team_id &&
    String(
      metadata.team_id
    ) !==
    String(
      team.id
    )
  ) {

    throw new Error(
      "Stripe team_id does not match the fundraiser team."
    );

  }


  if (
    metadata.player_id &&
    String(
      metadata.player_id
    ) !==
    String(
      player.id
    )
  ) {

    throw new Error(
      "Stripe player_id does not match the fundraiser player."
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


  const sessionId =
    String(
      session.id ||
      ""
    );


  const paymentIntentId =
    typeof session.payment_intent ===
    "string"
      ? session.payment_intent
      : session.payment_intent?.id ||
        "";


  const soldAt =
    new Date().toISOString();


  let databaseTotalCents =
    0;


  let newlySold =
    0;


  let alreadyProcessed =
    0;


  const conflicts =
    [];


  /*
    Process every baseball individually.

    This makes the behavior clear and
    prevents a Stripe retry from
    overwriting an existing donor.
  */

  for (
    const ballNumber
    of baseballNumbers
  ) {

    const rows =
      await supabaseRequest(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=eq.${ballNumber}&select=id,ball_number,amount_cents,status,donor_name,stripe_session_id&limit=1`
      );


    if (
      !Array.isArray(rows) ||
      !rows.length
    ) {

      throw new Error(
        `Baseball #${ballNumber} was not found for ${player.player_name}.`
      );

    }


    const baseball =
      rows[0];


    const amountCents =
      Number(
        baseball.amount_cents
      ) ||
      ballNumber * 100;


    databaseTotalCents +=
      amountCents;


    const status =
      String(
        baseball.status ||
        ""
      ).toLowerCase();


    const existingSession =
      String(
        baseball.stripe_session_id ||
        ""
      );


    /*
      Stripe retried the same webhook.
      Nothing else needs to happen.
    */

    if (
      status === "sold" &&
      existingSession ===
      sessionId
    ) {

      alreadyProcessed++;

      continue;

    }


    /*
      Another successful checkout already
      owns this baseball.

      Never overwrite that donor.
    */

    if (
      status === "sold" &&
      existingSession &&
      existingSession !==
      sessionId
    ) {

      conflicts.push(
        ballNumber
      );


      console.error(
        `PAYMENT CONFLICT: Baseball #${ballNumber} for ${player.player_name} is already sold by Stripe session ${existingSession}. New paid session: ${sessionId}.`
      );


      continue;

    }


    /*
      Update this baseball with the
      donor's chosen display name.
    */

    const updated =
      await supabaseRequest(
        env,
        `baseballs?id=eq.${encodeURIComponent(
          baseball.id
        )}`,
        {
          method: "PATCH",

          headers: {
            "content-type":
              "application/json",

            prefer:
              "return=representation"
          },

          body:
            JSON.stringify({
              status:
                "sold",

              donor_name:
                donorName,

              donor_email:
                donorEmail ||
                null,

              stripe_session_id:
                sessionId,

              sold_at:
                soldAt,

              reserved_until:
                null,

              reservation_id:
                null
            })
        }
      );


    if (
      Array.isArray(updated) &&
      updated.length
    ) {

      newlySold++;

    }

  }


  /* =========================
     VERIFY STRIPE TOTAL
  ========================= */

  const stripeTotalCents =
    Number(
      session.amount_total ||
      0
    );


  if (
    stripeTotalCents &&
    databaseTotalCents &&
    stripeTotalCents !==
    databaseTotalCents
  ) {

    console.error(
      "PAYMENT AMOUNT MISMATCH",
      {
        sessionId,
        playerKey,
        baseballNumbers,
        stripeTotalCents,
        databaseTotalCents
      }
    );

  }


  /* =========================
     RECORD DONATION
  ========================= */

  try {

    await recordDonation(
      env,
      {
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
          stripeTotalCents ||
          databaseTotalCents,

        donorName,

        donorEmail,

        sessionId,

        paymentIntentId,

        balls:
          baseballNumbers
      }
    );

  } catch (
    donationError
  ) {

    /*
      Important:
      baseballs are already fulfilled.

      Do NOT make Stripe retry fulfillment
      simply because donation logging failed.
    */

    console.error(
      "Donation logging error:",
      donationError
    );

  }


  return {
    success: true,

    type:
      "baseballs",

    playerKey,

    donorName,

    baseballNumbers,

    newlySold,

    alreadyProcessed,

    conflicts
  };

}


/* =========================================================
   PROCESS GENERAL DONATION
========================================================= */

async function processGeneralDonation(
  env,
  session
) {

  const metadata =
    session.metadata || {};


  const teamKey =
    String(
      metadata.team_key ||
      env.TEAM_KEY ||
      ""
    ).trim();


  if (
    !teamKey
  ) {

    throw new Error(
      "Missing team_key in Stripe metadata."
    );

  }


  if (
    teamKey !==
    env.TEAM_KEY
  ) {

    throw new Error(
      "Stripe team_key does not match this fundraiser."
    );

  }


  const donationType =
    String(
      metadata.donation_type ||
      ""
    ).trim();


  if (
    donationType !==
      "player_general" &&
    donationType !==
      "team_general"
  ) {

    throw new Error(
      `Unsupported donation type: ${donationType}`
    );

  }


  const team =
    await getTeam(
      env,
      teamKey
    );


  if (
    metadata.team_id &&
    String(
      metadata.team_id
    ) !==
    String(
      team.id
    )
  ) {

    throw new Error(
      "Stripe team_id does not match the fundraiser team."
    );

  }


  let player =
    null;


  const playerKey =
    String(
      metadata.player_key ||
      ""
    ).trim();


  if (
    donationType ===
    "player_general"
  ) {

    if (
      !playerKey
    ) {

      throw new Error(
        "Player donation is missing player_key."
      );

    }


    player =
      await getPlayer(
        env,
        team.id,
        playerKey
      );


    if (
      metadata.player_id &&
      String(
        metadata.player_id
      ) !==
      String(
        player.id
      )
    ) {

      throw new Error(
        "Stripe player_id does not match the fundraiser player."
      );

    }

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
      session.amount_total ||
      metadata.amount_cents ||
      0
    );


  if (
    !Number.isInteger(
      amountCents
    ) ||
    amountCents <= 0
  ) {

    throw new Error(
      "Invalid general donation amount."
    );

  }


  const sessionId =
    String(
      session.id ||
      ""
    );


  const paymentIntentId =
    typeof session.payment_intent ===
    "string"
      ? session.payment_intent
      : session.payment_intent?.id ||
        "";


  await recordDonation(
    env,
    {
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

      sessionId,

      paymentIntentId,

      balls:
        []
    }
  );


  return {
    success: true,

    type:
      donationType,

    playerKey:
      player?.player_key ||
      null,

    donorName,

    amountCents
  };

}


/* =========================================================
   PROCESS PAID CHECKOUT
========================================================= */

async function processPaidCheckout(
  env,
  session
) {

  if (
    session.payment_status !==
    "paid"
  ) {

    return {
      success: true,

      ignored: true,

      reason:
        "Checkout session is not paid."
    };

  }


  const metadata =
    session.metadata || {};


  const teamKey =
    String(
      metadata.team_key ||
      ""
    ).trim();


  /*
    Ignore Stripe events belonging
    to another fundraiser.
  */

  if (
    teamKey &&
    teamKey !==
    env.TEAM_KEY
  ) {

    return {
      success: true,

      ignored: true,

      reason:
        "Event belongs to another team."
    };

  }


  const donationType =
    String(
      metadata.donation_type ||
      "baseballs"
    ).trim();


  if (
    donationType ===
    "baseballs"
  ) {

    return processBaseballPurchase(
      env,
      session
    );

  }


  if (
    donationType ===
      "player_general" ||
    donationType ===
      "team_general"
  ) {

    return processGeneralDonation(
      env,
      session
    );

  }


  return {
    success: true,

    ignored: true,

    reason:
      `Unsupported donation type: ${donationType}`
  };

}


/* =========================================================
   WEBHOOK
========================================================= */

export async function onRequestPost({
  request,
  env
}) {

  try {

    /* =========================
       CONFIG
    ========================= */

    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_WEBHOOK_SECRET ||
      !env.TEAM_KEY
    ) {

      return json(
        {
          success: false,

          error:
            "Missing webhook configuration."
        },
        500
      );

    }


    /* =========================
       RAW BODY
    ========================= */

    const payload =
      await request.text();


    const signature =
      request.headers.get(
        "stripe-signature"
      );


    /* =========================
       VERIFY STRIPE
    ========================= */

    const verified =
      await verifyStripeSignature(
        payload,
        signature,
        env.STRIPE_WEBHOOK_SECRET
      );


    if (
      !verified
    ) {

      console.error(
        "Invalid Stripe webhook signature."
      );


      return json(
        {
          success: false,

          error:
            "Invalid Stripe signature."
        },
        400
      );

    }


    /* =========================
       PARSE EVENT
    ========================= */

    let event;


    try {

      event =
        JSON.parse(
          payload
        );

    } catch {

      return json(
        {
          success: false,

          error:
            "Invalid webhook JSON."
        },
        400
      );

    }


    /* =========================
       SUPPORTED EVENTS
    ========================= */

    const supportedEvents =
      new Set([
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded"
      ]);


    if (
      !supportedEvents.has(
        event.type
      )
    ) {

      return json({
        success: true,

        ignored: true,

        eventType:
          event.type
      });

    }


    const session =
      event?.data?.object;


    if (
      !session ||
      !session.id
    ) {

      return json(
        {
          success: false,

          error:
            "Stripe checkout session missing from event."
        },
        400
      );

    }


    /* =========================
       PROCESS PAYMENT
    ========================= */

    const result =
      await processPaidCheckout(
        env,
        session
      );


    console.log(
      "Stripe webhook processed:",
      {
        eventId:
          event.id,

        eventType:
          event.type,

        sessionId:
          session.id,

        result
      }
    );


    return json({
      received: true,
      ...result
    });


  } catch (
    error
  ) {

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
          error instanceof Error
            ? error.message
            : String(
                error
              )
      },
      500
    );

  }

}
