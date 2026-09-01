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
    if (
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

    const url =
      new URL(request.url);

    const playerKey =
      url.searchParams.get("player");

    if (!playerKey) {
      return json(
        {
          success: false,
          error:
            "Missing player parameter.",
        },
        400
      );
    }

    /*
      PLAYER LOOKUP

      Expected players table fields:

      id
      team_key
      player_key
      player_name
      player_number
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
      BASEBALL LOOKUP

      Expected baseballs table fields:

      id
      team_key
      player_key
      ball_number
      sold
      donor_name
      amount
    */

    const baseballRows =
      await supabaseGet(
        env,
        [
          "baseballs",
          "?select=ball_number,sold,amount,donor_name",
          `&team_key=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}`,
          `&player_key=eq.${encodeURIComponent(
            playerKey
          )}`,
          "&order=ball_number.asc",
        ].join("")
      );

    const soldBaseballs =
      Array.isArray(baseballRows)
        ? baseballRows.filter(
            row =>
              row.sold === true
          )
        : [];

    const soldBalls =
      soldBaseballs
        .map(row =>
          Number(
            row.ball_number
          )
        )
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    /*
      If amount is stored,
      use it.

      Otherwise the fundraiser rule is:
      ball # = donation amount.
    */

    const amountRaised =
      soldBaseballs.reduce(
        (total, row) => {
          const storedAmount =
            Number(row.amount);

          if (
            Number.isFinite(
              storedAmount
            ) &&
            storedAmount > 0
          ) {
            return (
              total +
              storedAmount
            );
          }

          const ballNumber =
            Number(
              row.ball_number
            );

          return (
            total +
            (
              Number.isFinite(
                ballNumber
              )
                ? ballNumber
                : 0
            )
          );
        },
        0
      );

    return json({
      success: true,

      teamKey:
        env.TEAM_KEY,

      player: {
        id: player.id,
        key:
          player.player_key,
        name:
          player.player_name,
        number:
          player.player_number,
      },

      soldBalls,

      ballsSold:
        soldBalls.length,

      amountRaised,

      goal: 5050,

      baseballs:
        baseballRows.map(
          row => ({
            number:
              Number(
                row.ball_number
              ),

            sold:
              row.sold === true,

            amount:
              row.amount,

            donorName:
              row.donor_name ||
              null,
          })
        ),
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
