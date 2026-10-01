export interface PreparedUploadRecord {
  openai_upload_filename: string;
  file_path: string;
  attributes: Record<string, string | number | boolean>;
}

export function approvePreparedRecords(records: PreparedUploadRecord[]): PreparedUploadRecord[] {
  const ids = new Set<string>();
  if (!records.length) throw new Error("No prepared sources selected for approval.");
  return records.map(record => {
    const id = record.attributes.source_id;
    if (typeof id !== "string" || !id || ids.has(id) || record.attributes.rights_status !== "review_required") {
      throw new Error("Approval requires unique, review-required prepared sources.");
    }
    ids.add(id);
    return { ...record, attributes: { ...record.attributes, rights_status: "approved" } };
  });
}
