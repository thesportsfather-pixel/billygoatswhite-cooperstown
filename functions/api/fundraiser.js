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
   MAIN
========================= */

export async function onRequestGet({
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
       PLAYER KEY
    ========================= */

    const url =
      new URL(
        request.url
      );

    const playerKey =
      String(
        url.searchParams.get(
          "player"
        ) || ""
      ).trim();


    if (
      !playerKey
    ) {

      return json(
        {
          success: false,
          error:
            "Player is required."
        },
        400
      );

    }


    /* =========================
       TEAM
    ========================= */

    const teams =
      await supabaseGet(
        env,
        `teams?team_key=eq.${encodeURIComponent(
          env.TEAM_KEY
        )}&select=id,team_key,team_name,website_domain,primary_color,secondary_color,logo_url&limit=1`
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
       PLAYER
    ========================= */

    const players =
      await supabaseGet(
        env,
        `players?team_id=eq.${encodeURIComponent(
          team.id
        )}&player_key=eq.${encodeURIComponent(
          playerKey
        )}&select=id,player_key,player_name,player_number,slug,name&limit=1`
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
       BASEBALLS
    ========================= */

    const baseballRows =
      await supabaseGet(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&select=id,ball_number,amount_cents,status,reserved_until,reservation_id,sold_at,stripe_session_id,donor_name,donor_email&order=ball_number.asc`
      );


    /* =========================
       NORMALIZE BASEBALLS
    ========================= */

    const baseballs =
      baseballRows.map(
        row => {

          const status =
            String(
              row.status ||
              "available"
            ).toLowerCase();

          const sold =
            status ===
            "sold";

          const reserved =
            status ===
            "reserved";

          const donorName =
            sold
              ? (
                  String(
                    row.donor_name ||
                    ""
                  ).trim() ||
                  "Anonymous"
                )
              : "";

          return {

            id:
              row.id,

            ball_number:
              Number(
                row.ball_number
              ),

            ballNumber:
              Number(
                row.ball_number
              ),

            number:
              Number(
                row.ball_number
              ),

            amount_cents:
              Number(
                row.amount_cents ||
                0
              ),

            amount:
              Number(
                row.amount_cents ||
                0
              ) / 100,

            status,

            sold,

            reserved,

            reserved_until:
              row.reserved_until,

            reservation_id:
              row.reservation_id,

            sold_at:
              row.sold_at,

            stripe_session_id:
              row.stripe_session_id,

            donor_name:
              donorName,

            donorName,

            donor_email:
              row.donor_email || null

          };

        }
      );


    /* =========================
       BASEBALL TOTALS
    ========================= */

    const soldBaseballs =
      baseballs.filter(
        ball =>
          ball.sold
      );


    const baseballRaisedCents =
      soldBaseballs.reduce(
        (
          total,
          ball
        ) =>
          total +
          Number(
            ball.amount_cents ||
            ball.ball_number *
            100
          ),
        0
      );


    /* =========================
       CUSTOM PLAYER DONATIONS
    ========================= */

    let generalDonations =
      [];


    try {

      generalDonations =
        await supabaseGet(
          env,
          `donations?team_key=eq.${encodeURIComponent(
            env.TEAM_KEY
          )}&player_id=eq.${encodeURIComponent(
            player.id
          )}&donation_type=eq.player_general&select=id,amount_cents,donor_name,donor_email,stripe_session_id,created_at&order=created_at.desc`
        );

    } catch (
      donationError
    ) {

      /*
        Keep fundraiser usable even
        if the donations table has
        an issue.
      */

      console.error(
        "Unable to load custom donations:",
        donationError
      );

      generalDonations =
        [];

    }


    const generalRaisedCents =
      generalDonations.reduce(
        (
          total,
          donation
        ) =>
          total +
          Number(
            donation.amount_cents ||
            0
          ),
        0
      );


    /* =========================
       COMBINED TOTAL
    ========================= */

    const totalRaisedCents =
      baseballRaisedCents +
      generalRaisedCents;


    const goalCents =
      505000;


    const percentage =
      Math.min(
        100,
        Math.max(
          0,
          (
            totalRaisedCents /
            goalCents
          ) *
          100
        )
      );


    /* =========================
       SOLD / RESERVED ARRAYS
    ========================= */

    const soldBalls =
      soldBaseballs.map(
        ball =>
          ball.ball_number
      );


    const reservedBalls =
      baseballs
        .filter(
          ball =>
            ball.reserved
        )
        .map(
          ball =>
            ball.ball_number
        );


    /* =========================
       RESPONSE
    ========================= */

    return json(
      {
        success: true,

        team: {
          id:
            team.id,

          key:
            team.team_key,

          teamKey:
            team.team_key,

          name:
            team.team_name,

          teamName:
            team.team_name,

          websiteDomain:
            team.website_domain,

          primaryColor:
            team.primary_color,

          secondaryColor:
            team.secondary_color,

          logoUrl:
            team.logo_url
        },


        player: {
          id:
            player.id,

          key:
            player.player_key,

          playerKey:
            player.player_key,

          name:
            player.player_name,

          playerName:
            player.player_name,

          number:
            player.player_number,

          playerNumber:
            player.player_number,

          slug:
            player.slug ||
            player.player_key
        },


        baseballs,


        soldBalls,


        reservedBalls,


        ballsSold:
          soldBaseballs.length,


        totalBalls:
          baseballs.length,


        baseballRaisedCents,


        baseballRaised:
          baseballRaisedCents /
          100,


        generalRaisedCents,


        generalRaised:
          generalRaisedCents /
          100,


        amountRaisedCents:
          totalRaisedCents,


        amountRaised:
          totalRaisedCents /
          100,


        goalCents,


        goal:
          goalCents /
          100,


        percentage,


        totals: {

          soldCount:
            soldBaseballs.length,

          totalBalls:
            baseballs.length,

          baseballRaisedCents,

          baseballRaisedDollars:
            baseballRaisedCents /
            100,

          generalRaisedCents,

          generalRaisedDollars:
            generalRaisedCents /
            100,

          raisedCents:
            totalRaisedCents,

          raisedDollars:
            totalRaisedCents /
            100,

          goalCents,

          goalDollars:
            goalCents /
            100,

          percentage

        },


        generalDonations:
          generalDonations.map(
            donation => ({
              amountCents:
                Number(
                  donation.amount_cents ||
                  0
                ),

              amount:
                Number(
                  donation.amount_cents ||
                  0
                ) / 100,

              donorName:
                String(
                  donation.donor_name ||
                  ""
                ).trim() ||
                "Anonymous",

              createdAt:
                donation.created_at
            })
          )

      }
    );


  } catch (
    error
  ) {

    console.error(
      "Fundraiser API error:",
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
