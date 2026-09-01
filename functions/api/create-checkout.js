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


/* =========================
   SUPABASE HELPERS
========================= */

async function supabaseGet(
  env,
  path
) {

  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method:
          "GET",

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json"
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

  return text
    ? JSON.parse(text)
    : [];

}


/* =========================
   MAIN HANDLER
========================= */

export async function onRequestPost({
  request,
  env
}) {

  try {

    /* =========================
       VERIFY CONFIG
    ========================= */

    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_SECRET_KEY ||
      !env.TEAM_KEY
    ) {

      return json(
        {
          success: false,

          error:
            "Missing server configuration."
        },
        500
      );

    }


    /* =========================
       READ REQUEST
    ========================= */

    const body =
      await request.json();

    const playerKey =
      String(
        body.playerKey ||
        body.player ||
        ""
      )
        .trim();

    const anonymous =
      body.anonymous === true;

    let donorName =
      String(
        body.donorName ||
        ""
      )
        .trim()
        .replace(
          /\s+/g,
          " "
        );


    /* =========================
       DONOR NAME
    ========================= */

    if (
      anonymous
    ) {

      donorName =
        "Anonymous";

    } else {

      if (
        !donorName
      ) {

        return json(
          {
            success: false,

            error:
              "Please enter a donor name or choose Remain Anonymous."
          },
          400
        );

      }

      if (
        donorName.length >
        50
      ) {

        donorName =
          donorName.slice(
            0,
            50
          );

      }

    }


    /* =========================
       BASEBALL NUMBERS

       Accept both:
       balls
       baseballs
    ========================= */

    const inputBalls =
      Array.isArray(
        body.balls
      )
        ? body.balls
        : Array.isArray(
            body.baseballs
          )
          ? body.baseballs
          : [];

    const baseballNumbers =
      Array.from(
        new Set(
          inputBalls
            .map(Number)
            .filter(
              number =>
                Number.isInteger(
                  number
                ) &&
                number >= 1 &&
                number <= 100
            )
        )
      )
        .sort(
          (
            a,
            b
          ) =>
            a - b
        );


    if (
      !playerKey
    ) {

      return json(
        {
          success: false,

          error:
            "A player is required."
        },
        400
      );

    }


    if (
      !baseballNumbers.length
    ) {

      return json(
        {
          success: false,

          error:
            "Choose at least one baseball."
        },
        400
      );

    }


    /* =========================
       FIND TEAM
    ========================= */

    const teams =
      await supabaseGet(
        env,
        `teams?team_key=eq.${encodeURIComponent(
          env.TEAM_KEY
        )}&select=id,team_key,team_name&limit=1`
      );


    if (
      !teams.length
    ) {

      return json(
        {
          success: false,

          error:
            "Team not found."
        },
        404
      );

    }


    const team =
      teams[0];


    /* =========================
       FIND PLAYER
    ========================= */

    const players =
      await supabaseGet(
        env,
        `players?team_id=eq.${encodeURIComponent(
          team.id
        )}&player_key=eq.${encodeURIComponent(
          playerKey
        )}&select=id,player_key,player_name,player_number&limit=1`
      );


    if (
      !players.length
    ) {

      return json(
        {
          success: false,

          error:
            "Player not found."
        },
        404
      );

    }


    const player =
      players[0];


    /* =========================
       LOAD SELECTED BASEBALLS
    ========================= */

    const baseballRows =
      await supabaseGet(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${baseballNumbers.join(
          ","
        )})&select=id,ball_number,amount_cents,status,reserved_until,stripe_session_id`
      );


    if (
      baseballRows.length !==
      baseballNumbers.length
    ) {

      return json(
        {
          success: false,

          error:
            "One or more selected baseballs could not be found."
        },
        409
      );

    }


    /* =========================
       CHECK AVAILABILITY
    ========================= */

    const now =
      Date.now();

    const unavailable =
      baseballRows.filter(
        baseball => {

          const status =
            String(
              baseball.status ||
              ""
            )
              .toLowerCase();

          if (
            status ===
            "sold"
          ) {

            return true;

          }


          if (
            status ===
            "reserved"
          ) {

            if (
              !baseball.reserved_until
            ) {

              return true;

            }

            const reservedUntil =
              new Date(
                baseball.reserved_until
              ).getTime();

            /*
              Expired reservations are
              treated as available.
            */

            if (
              Number.isFinite(
                reservedUntil
              ) &&
              reservedUntil >
              now
            ) {

              return true;

            }

          }


          return false;

        }
      );


    if (
      unavailable.length
    ) {

      return json(
        {
          success: false,

          error:
            `Baseball${
              unavailable.length === 1
                ? ""
                : "s"
            } #${unavailable
              .map(
                ball =>
                  ball.ball_number
              )
              .join(
                ", #"
              )} ${
                unavailable.length === 1
                  ? "is"
                  : "are"
              } no longer available. Please refresh and choose again.`
        },
        409
      );

    }


    /* =========================
       CALCULATE TOTAL
       FROM DATABASE ONLY
    ========================= */

    const totalCents =
      baseballRows.reduce(
        (
          total,
          baseball
        ) => {

          const amount =
            Number(
              baseball.amount_cents
            );

          if (
            Number.isFinite(
              amount
            ) &&
            amount > 0
          ) {

            return (
              total +
              amount
            );

          }

          return (
            total +
            Number(
              baseball.ball_number
            ) *
            100
          );

        },
        0
      );


    if (
      !Number.isInteger(
        totalCents
      ) ||
      totalCents <
      50
    ) {

      return json(
        {
          success: false,

          error:
            "Invalid checkout amount."
        },
        400
      );

    }


    /* =========================
       RETURN TO PLAYER PAGE
       TBT-STYLE
    ========================= */

    const origin =
      new URL(
        request.url
      ).origin;


    const successUrl =
      `${origin}/fundraiser.html?player=${encodeURIComponent(
        playerKey
      )}&payment=success&session_id={CHECKOUT_SESSION_ID}`;


    const cancelUrl =
      `${origin}/fundraiser.html?player=${encodeURIComponent(
        playerKey
      )}&payment=cancelled`;


    /* =========================
       STRIPE CHECKOUT
    ========================= */

    const stripeParams =
      new URLSearchParams();


    stripeParams.set(
      "mode",
      "payment"
    );


    stripeParams.set(
      "success_url",
      successUrl
    );


    stripeParams.set(
      "cancel_url",
      cancelUrl
    );


    stripeParams.set(
      "line_items[0][price_data][currency]",
      "usd"
    );


    stripeParams.set(
      "line_items[0][price_data][product_data][name]",
      `Boca Billygoats Cooperstown - ${player.player_name}`
    );


    stripeParams.set(
      "line_items[0][price_data][product_data][description]",
      `Baseballs #${baseballNumbers.join(
        ", #"
      )} • Donor: ${donorName}`
    );


    stripeParams.set(
      "line_items[0][price_data][unit_amount]",
      String(
        totalCents
      )
    );


    stripeParams.set(
      "line_items[0][quantity]",
      "1"
    );


    /* =========================
       CHECKOUT METADATA
    ========================= */

    stripeParams.set(
      "metadata[team_key]",
      env.TEAM_KEY
    );


    stripeParams.set(
      "metadata[team_id]",
      String(
        team.id
      )
    );


    stripeParams.set(
      "metadata[player_id]",
      String(
        player.id
      )
    );


    stripeParams.set(
      "metadata[player_key]",
      player.player_key
    );


    stripeParams.set(
      "metadata[player_name]",
      player.player_name
    );


    stripeParams.set(
      "metadata[player_number]",
      String(
        player.player_number ??
        ""
      )
    );


    /*
      Send both names for compatibility
      with webhook versions.
    */

    stripeParams.set(
      "metadata[balls]",
      baseballNumbers.join(
        ","
      )
    );


    stripeParams.set(
      "metadata[baseball_numbers]",
      baseballNumbers.join(
        ","
      )
    );


    stripeParams.set(
      "metadata[donor_name]",
      donorName
    );


    stripeParams.set(
      "metadata[anonymous]",
      String(
        anonymous
      )
    );


    stripeParams.set(
      "metadata[donation_type]",
      "baseballs"
    );


    stripeParams.set(
      "metadata[amount_cents]",
      String(
        totalCents
      )
    );


    /* =========================
       PAYMENT INTENT METADATA
    ========================= */

    stripeParams.set(
      "payment_intent_data[metadata][team_key]",
      env.TEAM_KEY
    );


    stripeParams.set(
      "payment_intent_data[metadata][team_id]",
      String(
        team.id
      )
    );


    stripeParams.set(
      "payment_intent_data[metadata][player_id]",
      String(
        player.id
      )
    );


    stripeParams.set(
      "payment_intent_data[metadata][player_key]",
      player.player_key
    );


    stripeParams.set(
      "payment_intent_data[metadata][player_name]",
      player.player_name
    );


    stripeParams.set(
      "payment_intent_data[metadata][player_number]",
      String(
        player.player_number ??
        ""
      )
    );


    stripeParams.set(
      "payment_intent_data[metadata][balls]",
      baseballNumbers.join(
        ","
      )
    );


    stripeParams.set(
      "payment_intent_data[metadata][baseball_numbers]",
      baseballNumbers.join(
        ","
      )
    );


    stripeParams.set(
      "payment_intent_data[metadata][donor_name]",
      donorName
    );


    stripeParams.set(
      "payment_intent_data[metadata][anonymous]",
      String(
        anonymous
      )
    );


    stripeParams.set(
      "payment_intent_data[metadata][donation_type]",
      "baseballs"
    );


    stripeParams.set(
      "payment_intent_data[metadata][amount_cents]",
      String(
        totalCents
      )
    );


    /* =========================
       CREATE STRIPE SESSION
    ========================= */

    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method:
            "POST",

          headers: {
            authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,

            "content-type":
              "application/x-www-form-urlencoded",

            accept:
              "application/json"
          },

          body:
            stripeParams.toString()
        }
      );


    const stripeText =
      await stripeResponse.text();


    let session;


    try {

      session =
        JSON.parse(
          stripeText
        );

    } catch {

      return json(
        {
          success: false,

          error:
            `Stripe returned an invalid response: ${stripeText}`
        },
        500
      );

    }


    if (
      !stripeResponse.ok
    ) {

      return json(
        {
          success: false,

          error:
            session?.error?.message ||
            "Unable to create Stripe checkout session."
        },
        stripeResponse.status
      );

    }


    if (
      !session?.url
    ) {

      return json(
        {
          success: false,

          error:
            "Stripe checkout URL was not returned."
        },
        500
      );

    }


    return json(
      {
        success: true,

        url:
          session.url,

        sessionId:
          session.id,

        player:
          {
            key:
              player.player_key,

            name:
              player.player_name,

            number:
              player.player_number
          },

        baseballs:
          baseballNumbers,

        donorName,

        anonymous,

        amountCents:
          totalCents
      }
    );


  } catch (
    error
  ) {

    console.error(
      "Create checkout error:",
      error
    );


    return json(
      {
        success: false,

        error:
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
