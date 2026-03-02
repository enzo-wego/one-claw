export type IncidentStatus = "triggered" | "acknowledged" | "resolved";

export interface AckResult {
  success: boolean;
  error?: string;
}

export async function getPagerDutyIncidentStatus(
  incidentId: string,
  apiToken: string
): Promise<IncidentStatus | null> {
  try {
    const res = await fetch(
      `https://api.pagerduty.com/incidents/${incidentId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Token token=${apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.pagerduty+json;version=2",
        },
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[PagerDuty] Failed to get incident ${incidentId} status: HTTP ${res.status}: ${body}`);
      return null;
    }

    const data = (await res.json()) as { incident?: { status?: string } };
    const status = data.incident?.status;
    if (status === "triggered" || status === "acknowledged" || status === "resolved") {
      return status;
    }
    console.error(`[PagerDuty] Unexpected incident status: ${status}`);
    return null;
  } catch (err) {
    console.error(`[PagerDuty] Error fetching incident ${incidentId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function acknowledgePagerDutyIncident(
  incidentId: string,
  apiToken: string,
  fromEmail: string
): Promise<AckResult> {
  try {
    const res = await fetch(
      `https://api.pagerduty.com/incidents/${incidentId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Token token=${apiToken}`,
          From: fromEmail,
          "Content-Type": "application/json",
          Accept: "application/vnd.pagerduty+json;version=2",
        },
        body: JSON.stringify({
          incident: {
            type: "incident_reference",
            status: "acknowledged",
          },
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, error: `HTTP ${res.status}: ${body}` };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
