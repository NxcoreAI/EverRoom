import { ProductLogo } from './ProductLogo'
import { PRODUCT_NAME } from './brand'

export function ProductBrand({ className }: { className?: string }) {
  const classes = ['product-brand', className].filter(Boolean).join(' ')

  return (
    <div className={classes} aria-label={PRODUCT_NAME}>
      <ProductLogo className="product-brand-logo product-brand-logo-full" variant="full" />
      <ProductLogo className="product-brand-logo product-brand-logo-icon" />
    </div>
  )
}
