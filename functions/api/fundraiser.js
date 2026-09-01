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

export async function onRequestGet({
  request,
  env,
}) {
  try {
    // =====================================================
    // REQUIRED ENVIRONMENT VARIABLES
    // =====================================================

    if (
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
    // GET PLAYER SLUG
    // =====================================================

    const url = new URL(request.url);

    const playerKey = (
      url.searchParams.get("player") || ""
    )
      .trim()
      .toLowerCase();

    if (!playerKey) {
      return json(
        {
          success: false,
          error: "Missing player.",
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

    const player = playerRows[0];

    // =====================================================
    // GET ALL 100 BASEBALLS
    // =====================================================

    const baseballRows = await supabaseGet(
      env,
      [
        "baseballs",
        "?select=id,ball_number,amount_cents,status,donor_name,donor_email,sold_at,stripe_session_id",
        `&player_id=eq.${encodeURIComponent(
          player.id
        )}`,
        "&order=ball_number.asc",
      ].join("")
    );

    // =====================================================
    // NORMALIZE BASEBALL DATA
    // =====================================================

    const baseballs = baseballRows.map(
      (ball) => {
        const ballNumber =
          Number(ball.ball_number);

        const amountCents =
          Number(ball.amount_cents || 0);

        const status =
          String(
            ball.status || "available"
          ).toLowerCase();

        const sold =
          status === "sold";

        const reserved =
          status === "reserved";

        return {
          id: ball.id,

          ballNumber,

          ball_number: ballNumber,

          amountCents,

          amount_cents: amountCents,

          amount:
            amountCents / 100,

          status,

          sold,

          reserved,

          donorName:
            ball.donor_name || null,

          donor_name:
            ball.donor_name || null,

          soldAt:
            ball.sold_at || null,

          sold_at:
            ball.sold_at || null,
        };
      }
    );

    // =====================================================
    // SOLD BASEBALLS
    // =====================================================

    const soldBaseballs =
      baseballs.filter(
        (ball) => ball.sold
      );

    const soldBalls =
      soldBaseballs.map(
        (ball) => ball.ballNumber
      );

    // =====================================================
    // AMOUNT RAISED
    // =====================================================

    const amountRaisedCents =
      soldBaseballs.reduce(
        (total, ball) =>
          total + ball.amountCents,
        0
      );

    const amountRaised =
      amountRaisedCents / 100;

    // =====================================================
    // RESERVED BALLS
    // =====================================================

    const reservedBalls =
      baseballs
        .filter(
          (ball) => ball.reserved
        )
        .map(
          (ball) =>
            ball.ballNumber
        );

    // =====================================================
    // RETURN FUNDRAISER DATA
    // =====================================================

    return json({
      success: true,

      team: {
        id: team.id,
        key: team.team_key,
        name: team.team_name,
      },

      player: {
        id: player.id,

        key:
          player.player_key,

        playerKey:
          player.player_key,

        slug:
          player.slug ||
          player.player_key,

        name:
          player.player_name ||
          player.name,

        playerName:
          player.player_name ||
          player.name,

        number:
          player.player_number,

        playerNumber:
          player.player_number,
      },

      baseballs,

      soldBalls,

      reservedBalls,

      ballsSold:
        soldBalls.length,

      amountRaised,

      amountRaisedCents,

      goal: 5050,

      goalCents: 505000,

      totalBalls:
        baseballs.length,
    });
  } catch (error) {
    console.error(
      "Fundraiser API error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Unable to load fundraiser.",
        details:
          error?.message ||
          String(error),
      },
      500
    );
  }
}
