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

async function createStripeCheckout(
  env,
  {
    request,
    playerKey,
    playerName,
    playerNumber,
    balls,
    total,
  }
) {
  const url = new URL(request.url);

  const origin = url.origin;

  const params = new URLSearchParams();

  params.set("mode", "payment");

  params.set(
    "success_url",
    `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`
  );

  params.set(
    "cancel_url",
    `${origin}/fundraiser.html?player=${encodeURIComponent(
      playerKey
    )}`
  );

  params.set(
    "line_items[0][price_data][currency]",
    "usd"
  );

  params.set(
    "line_items[0][price_data][product_data][name]",
    `${playerName} — Cooperstown Baseball Fundraiser`
  );

  params.set(
    "line_items[0][price_data][product_data][description]",
    `Baseballs: ${balls.join(", ")}`
  );

  params.set(
    "line_items[0][price_data][unit_amount]",
    String(total * 100)
  );

  params.set(
    "line_items[0][quantity]",
    "1"
  );

  /*
    Stripe metadata.

    Keep these values simple strings.
    Do NOT send the baseballs as a database array.
  */

  params.set(
    "metadata[team_key]",
    env.TEAM_KEY
  );

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

  params.set(
    "metadata[balls]",
    balls.join(",")
  );

  params.set(
    "metadata[donation_type]",
    "baseballs"
  );

  params.set(
    "payment_intent_data[metadata][team_key]",
    env.TEAM_KEY
  );

  params.set(
    "payment_intent_data[metadata][player_key]",
    playerKey
  );

  params.set(
    "payment_intent_data[metadata][balls]",
    balls.join(",")
  );

  params.set(
    "payment_intent_data[metadata][donation_type]",
    "baseballs"
  );

  const stripeResponse = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",

      headers: {
        authorization:
          `Bearer ${env.STRIPE_SECRET_KEY}`,

        "content-type":
          "application/x-www-form-urlencoded",
      },

      body: params.toString(),
    }
  );

  const stripeText =
    await stripeResponse.text();

  let stripeData;

  try {
    stripeData =
      stripeText
        ? JSON.parse(stripeText)
        : {};
  } catch {
    stripeData = {};
  }

  if (!stripeResponse.ok) {
    throw new Error(
      `Stripe ${stripeResponse.status}: ${
        stripeData?.error?.message ||
        stripeText
      }`
    );
  }

  if (!stripeData.url) {
    throw new Error(
      "Stripe did not return a checkout URL."
    );
  }

  return stripeData;
}

export async function onRequestPost({
  request,
  env,
}) {
  try {
    /*
      SERVER CONFIGURATION
    */

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

    /*
      READ REQUEST
    */

    let body;

    try {
      body = await request.json();
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

    const playerKey =
      String(
        body.playerKey ||
        body.player ||
        ""
      ).trim();

    if (!playerKey) {
      return json(
        {
          success: false,
          error:
            "Missing player.",
        },
        400
      );
    }

    /*
      NORMALIZE BASEBALL NUMBERS
    */

    const requestedBalls =
      Array.isArray(body.balls)
        ? body.balls
        : [];

    const balls =
      [
        ...new Set(
          requestedBalls
            .map(Number)
            .filter(
              number =>
                Number.isInteger(number) &&
                number >= 1 &&
                number <= 100
            )
        ),
      ].sort((a, b) => a - b);

    if (!balls.length) {
      return json(
        {
          success: false,
          error:
            "Please select at least one baseball.",
        },
        400
      );
    }

    /*
      GET PLAYER FROM DATABASE.

      Do not trust the name/number sent
      from the browser.
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
            playerKey
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

    /*
      CHECK SOLD STATUS AGAIN ON SERVER.

      This is important because another donor
      could have purchased a baseball after the
      fundraiser page originally loaded.
    */

    const ballList =
      `(${balls.join(",")})`;

    const existingRows =
      await supabaseGet(
        env,
        [
          "baseballs",
          "?select=ball_number,sold",
          `&team_key=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}`,
          `&player_key=eq.${encodeURIComponent(
            playerKey
          )}`,
          `&ball_number=in.${encodeURIComponent(
            ballList
          )}`,
        ].join("")
      );

    const sold =
      existingRows
        .filter(
          row => row.sold === true
        )
        .map(
          row =>
            Number(row.ball_number)
        )
        .filter(Number.isFinite);

    if (sold.length) {
      return json(
        {
          success: false,
          error:
            sold.length === 1
              ? `Baseball #${sold[0]} has already been sponsored. Please choose another baseball.`
              : `Baseballs ${sold
                  .map(number => `#${number}`)
                  .join(
                    ", "
                  )} have already been sponsored. Please choose different baseballs.`,
          soldBalls: sold,
        },
        409
      );
    }

    /*
      DONATION TOTAL

      Ball number = dollar amount.
    */

    const total =
      balls.reduce(
        (sum, number) =>
          sum + number,
        0
      );

    if (
      !Number.isInteger(total) ||
      total < 1
    ) {
      return json(
        {
          success: false,
          error:
            "Invalid donation total.",
        },
        400
      );
    }

    /*
      CREATE STRIPE CHECKOUT
    */

    const session =
      await createStripeCheckout(
        env,
        {
          request,

          playerKey:
            player.player_key,

          playerName:
            player.player_name,

          playerNumber:
            player.player_number,

          balls,

          total,
        }
      );

    return json({
      success: true,

      url:
        session.url,

      sessionId:
        session.id,

      teamKey:
        env.TEAM_KEY,

      player: {
        key:
          player.player_key,

        name:
          player.player_name,

        number:
          player.player_number,
      },

      balls,

      total,
    });

  } catch (error) {
    console.error(
      "Create checkout error:",
      error
    );

    return json(
      {
        success: false,

        error:
          "Unable to create checkout.",

        details:
          error?.message ||
          String(error),
      },
      500
    );
  }
}
