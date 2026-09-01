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

function normalizeBalls(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((ball) => Number(ball))
        .filter(
          (ball) =>
            Number.isInteger(ball) &&
            ball >= 1 &&
            ball <= 100
        )
    ),
  ].sort((a, b) => a - b);
}

function stripeFormEncode(params) {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value === undefined ||
      value === null
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
    // REQUIRED ENVIRONMENT VARIABLES
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
    // READ REQUEST
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

    const playerKey = String(
      body.playerKey ||
      body.player ||
      ""
    )
      .trim()
      .toLowerCase();

    const balls =
      normalizeBalls(body.balls);

    if (!playerKey) {
      return json(
        {
          success: false,
          error: "Missing player.",
        },
        400
      );
    }

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

    // =====================================================
    // FIND TEAM
    // =====================================================

    const teamRows = await supabaseGet(
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

    const team = teamRows[0];

    // =====================================================
    // FIND PLAYER
    // =====================================================

    const playerRows = await supabaseGet(
      env,
      [
        "players",
        "?select=id,player_key,player_name,player_number,slug,name",
        `&team_id=eq.${encodeURIComponent(
          team.id
        )}`,
        `&player_key=eq.${encodeURIComponent(
          playerKey
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

    const player =
      playerRows[0];

    const playerName =
      player.player_name ||
      player.name ||
      player.player_key;

    const playerNumber =
      player.player_number;

    // =====================================================
    // LOAD SELECTED BASEBALLS
    // =====================================================

    const ballFilter =
      `(${balls.join(",")})`;

    const baseballRows =
      await supabaseGet(
        env,
        [
          "baseballs",
          "?select=id,player_id,ball_number,amount_cents,status,reserved_until,reservation_id,stripe_session_id",
          `&player_id=eq.${encodeURIComponent(
            player.id
          )}`,
          `&ball_number=in.${encodeURIComponent(
            ballFilter
          )}`,
          "&order=ball_number.asc",
        ].join("")
      );

    // =====================================================
    // MAKE SURE EVERY REQUESTED BALL EXISTS
    // =====================================================

    const returnedNumbers =
      new Set(
        baseballRows.map(
          (ball) =>
            Number(ball.ball_number)
        )
      );

    const missingBalls =
      balls.filter(
        (ball) =>
          !returnedNumbers.has(ball)
      );

    if (missingBalls.length) {
      return json(
        {
          success: false,
          error:
            "One or more baseballs could not be found.",
          unavailableBalls:
            missingBalls,
        },
        409
      );
    }

    // =====================================================
    // CHECK AVAILABILITY
    // =====================================================

    const now =
      Date.now();

    const unavailableBalls = [];

    for (const ball of baseballRows) {
      const status =
        String(
          ball.status || ""
        ).toLowerCase();

      if (status === "sold") {
        unavailableBalls.push(
          Number(ball.ball_number)
        );

        continue;
      }

      /*
       * If an old reservation has expired,
       * we allow checkout to continue.
       *
       * Active reservations remain unavailable.
       */

      if (status === "reserved") {
        const reservedUntil =
          ball.reserved_until
            ? new Date(
                ball.reserved_until
              ).getTime()
            : null;

        if (
          !reservedUntil ||
          reservedUntil > now
        ) {
          unavailableBalls.push(
            Number(
              ball.ball_number
            )
          );
        }
      }
    }

    if (unavailableBalls.length) {
      return json(
        {
          success: false,

          error:
            unavailableBalls.length === 1
              ? `Baseball #${unavailableBalls[0]} is no longer available.`
              : `Baseballs ${unavailableBalls
                  .map(
                    (number) =>
                      `#${number}`
                  )
                  .join(
                    ", "
                  )} are no longer available.`,

          unavailableBalls,
        },
        409
      );
    }

    // =====================================================
    // CALCULATE TOTAL FROM DATABASE
    // NEVER TRUST PRICE FROM FRONTEND
    // =====================================================

    let totalCents = 0;

    for (const ball of baseballRows) {
      const amountCents =
        Number(ball.amount_cents);

      if (
        !Number.isInteger(
          amountCents
        ) ||
        amountCents <= 0
      ) {
        throw new Error(
          `Invalid amount_cents for baseball #${ball.ball_number}.`
        );
      }

      totalCents +=
        amountCents;
    }

    if (totalCents < 50) {
      return json(
        {
          success: false,
          error:
            "Donation total is below Stripe's minimum charge.",
        },
        400
      );
    }

    // =====================================================
    // ORIGIN
    // =====================================================

    const requestUrl =
      new URL(request.url);

    const origin =
      requestUrl.origin;

    // =====================================================
    // STRIPE METADATA
    //
    // IMPORTANT:
    // balls are stored as:
    //
    // "1,12,47"
    //
    // NOT a PostgreSQL array.
    // =====================================================

    const ballsMetadata =
      balls.join(",");

    const description =
      balls.length === 1
        ? `Sponsor Baseball #${balls[0]} for ${playerName}`
        : `Sponsor ${balls.length} Baseballs for ${playerName}`;

    // =====================================================
    // CREATE STRIPE CHECKOUT SESSION
    // =====================================================

    const form =
      stripeFormEncode({
        mode: "payment",

        "payment_method_types[0]":
          "card",

        "line_items[0][price_data][currency]":
          "usd",

        "line_items[0][price_data][unit_amount]":
          totalCents,

        "line_items[0][price_data][product_data][name]":
          description,

        "line_items[0][quantity]":
          1,

        success_url:
          `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,

        cancel_url:
          `${origin}/fundraiser.html?player=${encodeURIComponent(
            player.player_key
          )}`,

        "metadata[team_key]":
          env.TEAM_KEY,

        "metadata[team_id]":
          team.id,

        "metadata[player_id]":
          player.id,

        "metadata[player_key]":
          player.player_key,

        "metadata[player_name]":
          playerName,

        "metadata[player_number]":
          playerNumber,

        "metadata[balls]":
          ballsMetadata,

        "metadata[donation_type]":
          "baseballs",

        "payment_intent_data[metadata][team_key]":
          env.TEAM_KEY,

        "payment_intent_data[metadata][team_id]":
          team.id,

        "payment_intent_data[metadata][player_id]":
          player.id,

        "payment_intent_data[metadata][player_key]":
          player.player_key,

        "payment_intent_data[metadata][player_name]":
          playerName,

        "payment_intent_data[metadata][player_number]":
          playerNumber,

        "payment_intent_data[metadata][balls]":
          ballsMetadata,

        "payment_intent_data[metadata][donation_type]":
          "baseballs",
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
        "Stripe checkout error:",
        stripeText
      );

      return json(
        {
          success: false,
          error:
            "Unable to create checkout session.",
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

      player: {
        id:
          player.id,

        key:
          player.player_key,

        name:
          playerName,

        number:
          playerNumber,
      },

      balls,

      totalCents,

      total:
        totalCents / 100,
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
