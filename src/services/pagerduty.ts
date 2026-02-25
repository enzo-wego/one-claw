export interface AckResult {
  success: boolean;
  error?: string;
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
