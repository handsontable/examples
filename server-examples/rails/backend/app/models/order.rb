class Order < ApplicationRecord
  STATUSES = %w[pending paid shipped delivered cancelled].freeze

  validates :order_number, presence: true, uniqueness: true
  validates :customer,     presence: true
  validates :status,       inclusion: { in: STATUSES }
  validates :total,        numericality: { greater_than_or_equal_to: 0 }

  default_scope -> { order(created_at: :desc) }

  # Handsontable's `date` cell type parses ISO 8601 *dates* only (`YYYY-MM-DD`);
  # a full timestamp is rejected and renders as a bad-value placeholder. Rails
  # serializes a `datetime` column as `2025-04-01T12:34:56.789Z`, so narrow
  # `created_at` to the date part for every JSON response.
  def as_json(options = {})
    json = super
    json["created_at"] = created_at&.to_date&.iso8601 if json.key?("created_at")
    json
  end
end
