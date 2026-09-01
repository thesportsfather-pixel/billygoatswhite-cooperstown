function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function supabaseGet(env, path) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

function stripeFormEncode(params) {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value === undefined ||
      value === null ||
      value === ""
    ) {
      continue;
    }

    form.append(key, String(value));
  }

  return form;
}

export async function onRequestPost({
  request,
  env,
}) {
  try {
    // =====================================================
    // REQUIRED CONFIG
    // =====================================================

    if (
      !env.STRIPE_SECRET_KEY ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY
    ) {
      return json(
        {
          success: false,
          error: "Missing server configuration.",
        },
        500
      );
    }

    // =====================================================
    // REQUEST BODY
    // =====================================================

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          success: false,
          error: "Invalid request body.",
        },
        400
      );
    }

    // Accept:
    // amount: 25
    // OR amount: "25"
    //
    // Amount is in dollars from frontend.

    const amount =
      Number(body.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return json(
        {
          success: false,
          error:
            "Please enter a valid donation amount.",
        },
        400
      );
    }

    const amountCents =
      Math.round(amount * 100);

    if (amountCents < 50) {
      return json(
        {
          success: false,
          error:
            "Donation amount is below Stripe's minimum charge.",
        },
        400
      );
    }

    // =====================================================
    // PLAYER VALUE IS OPTIONAL
    // =====================================================

    const requestedPlayerKey = String(
      body.playerKey ||
      body.player ||
      ""
    )
      .trim()
      .toLowerCase();

    // =====================================================
    // FIND TEAM
    // =====================================================

    const teamRows =
      await supabaseGet(
        env,
        [
          "teams",
          "?select=id,team_key,team_name",
          `&team_key=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}`,
          "&limit=1",
        ].join("")
      );

    if (!teamRows.length) {
      return json(
        {
          success: false,
          error: "Team not found.",
        },
        404
      );
    }

    const team =
      teamRows[0];

    // =====================================================
    // OPTIONAL PLAYER LOOKUP
    // =====================================================

    let player = null;

    if (requestedPlayerKey) {
      const playerRows =
        await supabaseGet(
          env,
          [
            "players",
            "?select=id,player_key,player_name,player_number,slug,name",
            `&team_id=eq.${encodeURIComponent(
              team.id
            )}`,
            `&player_key=eq.${encodeURIComponent(
              requestedPlayerKey
            )}`,
            "&limit=1",
          ].join("")
        );

      if (!playerRows.length) {
        return json(
          {
            success: false,
            error: "Player not found.",
          },
          404
        );
      }

      player =
        playerRows[0];
    }

    // =====================================================
    // DONATION TYPE
    // =====================================================

    const donationType =
      player
        ? "player_general"
        : "team_general";

    const playerName =
      player
        ? (
            player.player_name ||
            player.name ||
            player.player_key
          )
        : "";

    const playerNumber =
      player
        ? player.player_number
        : "";

    // =====================================================
    // CHECKOUT LABEL
    // =====================================================

    const productName =
      player
        ? `Donation for ${playerName}`
        : `${team.team_name} Team Donation`;

    const requestUrl =
      new URL(request.url);

    const origin =
      requestUrl.origin;

    const cancelUrl =
      player
        ? `${origin}/fundraiser.html?player=${encodeURIComponent(
            player.player_key
          )}`
        : `${origin}/`;

    // =====================================================
    // STRIPE CHECKOUT SESSION
    // =====================================================

    const form =
      stripeFormEncode({
        mode: "payment",

        "payment_method_types[0]":
          "card",

        "line_items[0][price_data][currency]":
          "usd",

        "line_items[0][price_data][unit_amount]":
          amountCents,

        "line_items[0][price_data][product_data][name]":
          productName,

        "line_items[0][quantity]":
          1,

        success_url:
          `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,

        cancel_url:
          cancelUrl,

        // ===============================================
        // CHECKOUT SESSION METADATA
        // ===============================================

        "metadata[team_key]":
          env.TEAM_KEY,

        "metadata[team_id]":
          team.id,

        "metadata[donation_type]":
          donationType,

        "metadata[amount_cents]":
          amountCents,

        "metadata[player_id]":
          player?.id,

        "metadata[player_key]":
          player?.player_key,

        "metadata[player_name]":
          playerName,

        "metadata[player_number]":
          playerNumber,

        // ===============================================
        // PAYMENT INTENT METADATA
        // ===============================================

        "payment_intent_data[metadata][team_key]":
          env.TEAM_KEY,

        "payment_intent_data[metadata][team_id]":
          team.id,

        "payment_intent_data[metadata][donation_type]":
          donationType,

        "payment_intent_data[metadata][amount_cents]":
          amountCents,

        "payment_intent_data[metadata][player_id]":
          player?.id,

        "payment_intent_data[metadata][player_key]":
          player?.player_key,

        "payment_intent_data[metadata][player_name]":
          playerName,

        "payment_intent_data[metadata][player_number]":
          playerNumber,
      });

    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",

          headers: {
            authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,

            "content-type":
              "application/x-www-form-urlencoded",
          },

          body: form,
        }
      );

    const stripeText =
      await stripeResponse.text();

    let stripeData;

    try {
      stripeData =
        JSON.parse(stripeText);
    } catch {
      stripeData = null;
    }

    if (
      !stripeResponse.ok ||
      !stripeData?.url
    ) {
      console.error(
        "Stripe general donation error:",
        stripeText
      );

      return json(
        {
          success: false,
          error:
            "Unable to create donation checkout.",
          details:
            stripeData?.error?.message ||
            stripeText,
        },
        500
      );
    }

    // =====================================================
    // SUCCESS
    // =====================================================

    return json({
      success: true,

      url:
        stripeData.url,

      checkoutUrl:
        stripeData.url,

      sessionId:
        stripeData.id,

      donationType,

      amount:
        amountCents / 100,

      amountCents,

      team: {
        id:
          team.id,

        key:
          team.team_key,

        name:
          team.team_name,
      },

      player:
        player
          ? {
              id:
                player.id,

              key:
                player.player_key,

              name:
                playerName,

              number:
                playerNumber,
            }
          : null,
    });
  } catch (error) {
    console.error(
      "General donation error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Unable to create donation.",
        details:
          error?.message ||
          String(error),
      },
      500
    );
  }
}
