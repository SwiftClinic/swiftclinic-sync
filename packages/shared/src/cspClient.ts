export interface CspClientOptions {
  host: string;
  apiKey: string;
}

export interface CspCreateParams {
  clinic_id: string;
  practitioner_key: string;
  appointment_type_key: string;
  start_iso: string;
  end_iso: string;
  patient_hash: string;
  idempotency_key: string;
}

export class CspClient {
  constructor(private opts: CspClientOptions) {}

  async createAppointment(p: CspCreateParams): Promise<{ csp_appointment_id: string }> {
    // TODO: call CSP API with idempotency header; return created or existing
    return { csp_appointment_id: `csp_${Date.now()}` };
  }

  async cancelAppointment(csp_appointment_id: string): Promise<void> {
    // TODO: cancel via CSP API
  }
}
