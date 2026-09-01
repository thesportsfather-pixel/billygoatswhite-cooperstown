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
   SUPABASE GET
========================= */

async function supabaseGet(
  env,
  path
) {

  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method: "GET",

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

  if (!response.ok) {

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
       CONFIG CHECK
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
       REQUEST BODY
    ========================= */

    const body =
      await request.json();


    const amount =
      Number(
        body.amount
      );


    const amountCents =
      Math.round(
        amount * 100
      );


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
       VALIDATE AMOUNT
    ========================= */

    if (
      !Number.isFinite(
        amount
      ) ||
      !Number.isInteger(
        amountCents
      ) ||
      amountCents < 100
    ) {

      return json(
        {
          success: false,

          error:
            "Please enter a donation amount of at least $1."
        },
        400
      );

    }


    /* =========================
       VALIDATE DONOR NAME
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
       OPTIONAL PLAYER
    ========================= */

    let player =
      null;


    if (
      playerKey
    ) {

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


      player =
        players[0];

    }


    /* =========================
       DONATION TYPE
    ========================= */

    const donationType =
      player
        ? "player_general"
        : "team_general";


    /* =========================
       SUCCESS / CANCEL URLS
    ========================= */

    const origin =
      new URL(
        request.url
      ).origin;


    let successUrl;

    let cancelUrl;


    if (
      player
    ) {

      successUrl =
        `${origin}/fundraiser.html?player=${encodeURIComponent(
          player.player_key
        )}&payment=success&session_id={CHECKOUT_SESSION_ID}`;


      cancelUrl =
        `${origin}/fundraiser.html?player=${encodeURIComponent(
          player.player_key
        )}&payment=cancelled`;

    } else {

      successUrl =
        `${origin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`;


      cancelUrl =
        `${origin}/?payment=cancelled`;

    }


    /* =========================
       STRIPE PARAMETERS
    ========================= */

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
      "line_items[0][price_data][unit_amount]",
      String(
        amountCents
      )
    );


    params.set(
      "line_items[0][quantity]",
      "1"
    );


    /* =========================
       PRODUCT NAME
    ========================= */

    if (
      player
    ) {

      params.set(
        "line_items[0][price_data][product_data][name]",
        `Boca Billygoats Cooperstown - ${player.player_name}`
      );


      params.set(
        "line_items[0][price_data][product_data][description]",
        `Custom player donation • Donor: ${donorName}`
      );

    } else {

      params.set(
        "line_items[0][price_data][product_data][name]",
        "Boca Billygoats 12U White - Team Donation"
      );


      params.set(
        "line_items[0][price_data][product_data][description]",
        `General team donation • Donor: ${donorName}`
      );

    }


    /* =========================
       SESSION METADATA
    ========================= */

    params.set(
      "metadata[team_key]",
      env.TEAM_KEY
    );


    params.set(
      "metadata[team_id]",
      String(
        team.id
      )
    );


    params.set(
      "metadata[donation_type]",
      donationType
    );


    params.set(
      "metadata[amount_cents]",
      String(
        amountCents
      )
    );


    params.set(
      "metadata[donor_name]",
      donorName
    );


    params.set(
      "metadata[anonymous]",
      String(
        anonymous
      )
    );


    if (
      player
    ) {

      params.set(
        "metadata[player_id]",
        String(
          player.id
        )
      );


      params.set(
        "metadata[player_key]",
        player.player_key
      );


      params.set(
        "metadata[player_name]",
        player.player_name
      );


      params.set(
        "metadata[player_number]",
        String(
          player.player_number ??
          ""
        )
      );

    }


    /* =========================
       PAYMENT INTENT METADATA
    ========================= */

    params.set(
      "payment_intent_data[metadata][team_key]",
      env.TEAM_KEY
    );


    params.set(
      "payment_intent_data[metadata][team_id]",
      String(
        team.id
      )
    );


    params.set(
      "payment_intent_data[metadata][donation_type]",
      donationType
    );


    params.set(
      "payment_intent_data[metadata][amount_cents]",
      String(
        amountCents
      )
    );


    params.set(
      "payment_intent_data[metadata][donor_name]",
      donorName
    );


    params.set(
      "payment_intent_data[metadata][anonymous]",
      String(
        anonymous
      )
    );


    if (
      player
    ) {

      params.set(
        "payment_intent_data[metadata][player_id]",
        String(
          player.id
        )
      );


      params.set(
        "payment_intent_data[metadata][player_key]",
        player.player_key
      );


      params.set(
        "payment_intent_data[metadata][player_name]",
        player.player_name
      );


      params.set(
        "payment_intent_data[metadata][player_number]",
        String(
          player.player_number ??
          ""
        )
      );

    }


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
            params.toString()
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


    /* =========================
       SUCCESS RESPONSE
    ========================= */

    return json(
      {
        success: true,

        url:
          session.url,

        sessionId:
          session.id,

        donationType,

        donorName,

        anonymous,

        amountCents,

        player:
          player
            ? {
                key:
                  player.player_key,

                name:
                  player.player_name,

                number:
                  player.player_number
              }
            : null
      }
    );


  } catch (
    error
  ) {

    console.error(
      "Create general donation error:",
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
