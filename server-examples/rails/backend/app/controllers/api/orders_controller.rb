module Api
  class OrdersController < ApplicationController
    SORTABLE_COLUMNS = %w[order_number customer status total created_at].freeze

    def index
      scope = Order.all
      scope = apply_filters(scope)
      scope = apply_sort(scope)
      scope = scope.page(params[:page]).per(params[:page_size] || 10)

      render json: { rows: scope.as_json, total_rows: scope.total_count }
    end

    def create_rows
      allowed = Order.column_names - %w[id created_at updated_at]

      rows = Order.transaction do
        Array(params[:rows]).map do |row|
          Order.create!(row.to_unsafe_h.slice(*allowed))
        end
      end

      render json: { rows: rows.as_json }, status: :created
    rescue ActiveRecord::RecordInvalid => e
      render json: { error: e.message }, status: :unprocessable_entity
    end

    def update_rows
      allowed = Order.column_names - %w[id created_at updated_at]

      updated = Order.transaction do
        Array(params[:rows]).map do |row|
          record  = Order.find(row[:id])
          changes = row[:changes].to_unsafe_h.slice(*allowed)
          record.update!(changes)
          record
        end
      end

      render json: { rows: updated.as_json }
    rescue ActiveRecord::RecordNotFound => e
      render json: { error: e.message }, status: :not_found
    rescue ActiveRecord::RecordInvalid => e
      render json: { error: e.message }, status: :unprocessable_entity
    end

    def remove_rows
      Order.where(id: Array(params[:row_ids])).delete_all
      head :no_content
    end

    private

    def apply_sort(scope)
      prop  = params[:sort_prop]
      order = params[:sort_order] == "desc" ? :desc : :asc

      return scope unless SORTABLE_COLUMNS.include?(prop)

      scope.reorder(prop => order)
    end

    def apply_filters(scope)
      filters = params[:filters]
      return scope if filters.blank?

      Array(filters.values).each do |filter|
        prop      = filter[:prop]
        value     = filter[:value]
        condition = filter[:condition].presence || "contains"

        next unless SORTABLE_COLUMNS.include?(prop)

        scope = case condition
                when "contains"     then scope.where("#{prop} ILIKE ?", "%#{value}%")
                when "not_contains" then scope.where.not("#{prop} ILIKE ?", "%#{value}%")
                when "eq"           then scope.where(prop => value)
                when "neq"          then scope.where.not(prop => value)
                when "begins_with"  then scope.where("#{prop} ILIKE ?", "#{value}%")
                when "ends_with"    then scope.where("#{prop} ILIKE ?", "%#{value}")
                when "gt"           then scope.where("#{prop} > ?", value)
                when "gte"          then scope.where("#{prop} >= ?", value)
                when "lt"           then scope.where("#{prop} < ?", value)
                when "lte"          then scope.where("#{prop} <= ?", value)
                when "empty"        then scope.where("#{prop} IS NULL OR #{prop} = ''")
                when "not_empty"    then scope.where.not("#{prop} IS NULL OR #{prop} = ''")
                else scope
                end
      end

      scope
    end
  end
end
