class Order < ApplicationRecord
  STATUSES = %w[pending paid shipped delivered cancelled].freeze

  validates :order_number, presence: true, uniqueness: true
  validates :customer,     presence: true
  validates :status,       inclusion: { in: STATUSES }
  validates :total,        numericality: { greater_than_or_equal_to: 0 }

  default_scope -> { order(created_at: :desc) }
end
