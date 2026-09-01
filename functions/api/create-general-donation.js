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
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization:
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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

async function createStripeSession(
  env,
  {
    request,
    amount,
    playerKey,
    playerName,
    playerNumber,
  }
) {
  const url = new URL(request.url);
  const origin = url.origin;

  const isPlayerDonation =
    Boolean(playerKey);

  const donationType =
    isPlayerDonation
      ? "player_general"
      : "team_general";

  const productName =
    isPlayerDonation
      ? `${playerName} — Cooperstown Donation`
      : "Boca Billygoats 12U White — Cooperstown Donation";

  const description =
    isPlayerDonation
      ? `General donation supporting ${playerName}'s Road to Cooperstown.`
      : "General donation supporting Boca Billygoats 12U White on their Road to Cooperstown.";

  const cancelUrl =
    isPlayerDonation
      ? `${origin}/fundraiser.html?player=${encodeURIComponent(
          playerKey
        )}`
      : `${origin}/`;

  const successUrl =
    `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`;

  const params =
    new URLSearchParams();

  params.set(
    "mode",
    "payment"
  );

  params.set(
    "success_url",
    successUrl
  );

  params.set(
    "cancel_url",
    cancelUrl
  );

  params.set(
    "line_items[0][price_data][currency]",
    "usd"
  );

  params.set(
    "line_items[0][price_data][product_data][name]",
    productName
  );

  params.set(
    "line_items[0][price_data][product_data][description]",
    description
  );

  params.set(
    "line_items[0][price_data][unit_amount]",
    String(amount * 100)
  );

  params.set(
    "line_items[0][quantity]",
    "1"
  );

  /*
    CHECKOUT SESSION METADATA
  */

  params.set(
    "metadata[team_key]",
    env.TEAM_KEY
  );

  params.set(
    "metadata[donation_type]",
    donationType
  );

  params.set(
    "metadata[amount]",
    String(amount)
  );

  if (isPlayerDonation) {
    params.set(
      "metadata[player_key]",
      playerKey
    );

    params.set(
      "metadata[player_name]",
      playerName
    );

    params.set(
      "metadata[player_number]",
      String(playerNumber)
    );
  }

  /*
    PAYMENT INTENT METADATA
  */

  params.set(
    "payment_intent_data[metadata][team_key]",
    env.TEAM_KEY
  );

  params.set(
    "payment_intent_data[metadata][donation_type]",
    donationType
  );

  params.set(
    "payment_intent_data[metadata][amount]",
    String(amount)
  );

  if (isPlayerDonation) {
    params.set(
      "payment_intent_data[metadata][player_key]",
      playerKey
    );
  }

  const response =
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

        body:
          params.toString(),
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      `Stripe ${response.status}: ${
        data?.error?.message ||
        text
      }`
    );
  }

  if (!data.url) {
    throw new Error(
      "Stripe did not return a checkout URL."
    );
  }

  return data;
}

export async function onRequestPost({
  request,
  env,
}) {
  try {
    if (
      !env.STRIPE_SECRET_KEY ||
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY
    ) {
      return json(
        {
          success: false,
          error:
            "Missing required server configuration.",
        },
        500
      );
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid request body.",
        },
        400
      );
    }

    /*
      DONATION AMOUNT
    */

    const rawAmount =
      Number(body.amount);

    if (
      !Number.isFinite(rawAmount) ||
      rawAmount < 1
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

    /*
      Donations are whole-dollar amounts.
    */

    const amount =
      Math.round(rawAmount);

    if (
      amount < 1 ||
      amount > 100000
    ) {
      return json(
        {
          success: false,
          error:
            "Invalid donation amount.",
        },
        400
      );
    }

    /*
      PLAYER IS OPTIONAL.

      If no player is supplied,
      this becomes a general team donation.
    */

    const requestedPlayerKey =
      String(
        body.playerKey ||
        body.player ||
        ""
      ).trim();

    let playerKey = null;
    let playerName = null;
    let playerNumber = null;

    if (requestedPlayerKey) {

      /*
        LOOK PLAYER UP IN SUPABASE.

        We do not trust the player
        name or number from the browser.
      */

      const playerRows =
        await supabaseGet(
          env,
          [
            "players",
            "?select=id,player_key,player_name,player_number",
            `&team_key=eq.${encodeURIComponent(
              env.TEAM_KEY
            )}`,
            `&player_key=eq.${encodeURIComponent(
              requestedPlayerKey
            )}`,
            "&limit=1",
          ].join("")
        );

      if (
        !Array.isArray(playerRows) ||
        playerRows.length === 0
      ) {
        return json(
          {
            success: false,
            error:
              "Player not found.",
          },
          404
        );
      }

      const player =
        playerRows[0];

      playerKey =
        player.player_key;

      playerName =
        player.player_name;

      playerNumber =
        player.player_number;
    }

    const session =
      await createStripeSession(
        env,
        {
          request,
          amount,
          playerKey,
          playerName,
          playerNumber,
        }
      );

    return json({
      success: true,

      url:
        session.url,

      sessionId:
        session.id,

      donationType:
        playerKey
          ? "player_general"
          : "team_general",

      teamKey:
        env.TEAM_KEY,

      amount,

      player:
        playerKey
          ? {
              key:
                playerKey,

              name:
                playerName,

              number:
                playerNumber,
            }
          : null,
    });

  } catch (error) {

    console.error(
      "General donation checkout error:",
      error
    );

    return json(
      {
        success: false,

        error:
          "Unable to create donation checkout.",

        details:
          error?.message ||
          String(error),
      },
      500
    );
  }
}
